use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoDevice {
    id: String,
    name: String,
    root: Option<String>,
    transport: &'static str,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    devices: Vec<PhotoDevice>,
    warning: Option<String>,
}

fn is_mass_storage_alias(id: &str) -> bool {
    // WPD also lists USB disks (including Sony's PMHOME volume), not just MTP.
    id.to_ascii_lowercase().contains("usbstor#")
}

// Only probe the standard camera directory, never recursively scan whole disks.
fn mounted_camera(root: &Path, label: &str, serial: u32) -> Option<PhotoDevice> {
    let dcim = root.join("DCIM");
    let metadata = std::fs::symlink_metadata(&dcim).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    let root_name = root.to_string_lossy();
    Some(PhotoDevice {
        id: format!("volume:{root_name}:{serial:08x}"),
        name: format!(
            "{} ({root_name})",
            if label.is_empty() {
                "相机 / 存储卡"
            } else {
                label
            }
        ),
        root: Some(dcim.to_string_lossy().into_owned()),
        transport: "msc",
    })
}

#[cfg(windows)]
pub fn discover() -> Result<Discovery, String> {
    use windows::{
        Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW},
        core::PCWSTR,
    };
    let mut result = Discovery::default();
    // SAFETY: buffers are null terminated and all out pointers live through each call.
    let drives = unsafe { GetLogicalDrives() };
    if drives == 0 {
        return Err("无法枚举存储设备，请重试或手动打开来源。".into());
    }
    for index in 0..26 {
        if drives & (1 << index) == 0 {
            continue;
        }
        let root = format!("{}:\\", (b'A' + index) as char);
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        let drive_type = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        // Some cameras expose fixed disks (3), not removable disks (2).
        if !matches!(drive_type, 2 | 3) {
            continue;
        }
        let mut label = [0u16; 261];
        let mut serial = 0;
        if unsafe {
            GetVolumeInformationW(
                PCWSTR(wide.as_ptr()),
                Some(&mut label),
                Some(&mut serial),
                None,
                None,
                None,
            )
        }
        .is_err()
        {
            continue;
        }
        let label = String::from_utf16_lossy(
            &label[..label.iter().position(|c| *c == 0).unwrap_or(label.len())],
        );
        if let Some(device) = mounted_camera(Path::new(&root), &label, serial) {
            result.devices.push(device);
        }
    }
    match portable_devices() {
        Ok(devices) => result.devices.extend(devices),
        Err(error) => {
            result.warning = Some(format!(
                "MTP 设备检测不可用：{error}。仍可使用存储卡或手动打开来源。"
            ))
        }
    }
    Ok(result)
}

#[cfg(windows)]
fn portable_devices() -> windows::core::Result<Vec<PhotoDevice>> {
    use windows::{
        Win32::{
            Devices::PortableDevices::{IPortableDeviceManager, PortableDeviceManager},
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
                CoTaskMemFree, CoUninitialize,
            },
        },
        core::{PCWSTR, PWSTR},
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    struct DeviceIds(Vec<PWSTR>);
    impl Drop for DeviceIds {
        fn drop(&mut self) {
            for id in &self.0 {
                unsafe { CoTaskMemFree(Some(id.0.cast())) };
            }
        }
    }
    // All COM objects stay on this blocking worker; RAII releases strings and the apartment.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let _apartment = Apartment;
        let manager: IPortableDeviceManager =
            CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER)?;
        manager.RefreshDeviceList()?;
        let mut count = 0;
        manager.GetDevices(std::ptr::null_mut(), &mut count)?;
        if count == 0 {
            return Ok(Vec::new());
        }
        let mut ids = DeviceIds(vec![PWSTR::null(); count as usize]);
        manager.GetDevices(ids.0.as_mut_ptr(), &mut count)?;
        let mut devices = Vec::new();
        for id in ids.0.iter().take(count as usize).filter(|id| !id.is_null()) {
            let device_id = id.to_string()?;
            if is_mass_storage_alias(&device_id) {
                continue;
            }
            let mut length = 0;
            let name = if manager
                .GetDeviceFriendlyName(PCWSTR(id.0), PWSTR::null(), &mut length)
                .is_ok()
                && length > 0
            {
                let mut buffer = vec![0u16; length as usize];
                manager
                    .GetDeviceFriendlyName(PCWSTR(id.0), PWSTR(buffer.as_mut_ptr()), &mut length)
                    .ok();
                String::from_utf16_lossy(
                    &buffer[..buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len())],
                )
            } else {
                String::new()
            };
            devices.push(PhotoDevice {
                id: format!("wpd:{device_id}"),
                name: if name.is_empty() {
                    "便携设备".into()
                } else {
                    name
                },
                root: None,
                transport: "mtp",
            });
        }
        Ok(devices)
    }
}

#[cfg(not(windows))]
pub fn discover() -> Result<Discovery, String> {
    Ok(Discovery::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_wpd_aliases_of_mass_storage_but_keeps_mtp() {
        assert!(is_mass_storage_alias(
            r"\\?\SWD#WPDBUSENUM#_??_USBSTOR#disk&ven_sony&prod_dsc"
        ));
        assert!(!is_mass_storage_alias(r"\\?\usb#vid_054c&pid_0ccc#camera"));
    }
    #[test]
    fn detects_only_dcim_without_scanning_or_modifying_photos() {
        let disk = tempfile::tempdir().unwrap();
        assert!(mounted_camera(disk.path(), "Sony", 1).is_none());
        std::fs::write(disk.path().join("DCIM"), b"not a directory").unwrap();
        assert!(mounted_camera(disk.path(), "Sony", 1).is_none());
        std::fs::remove_file(disk.path().join("DCIM")).unwrap();
        std::fs::create_dir(disk.path().join("DCIM")).unwrap();
        let photo = disk.path().join("DCIM/original.ARW");
        std::fs::write(&photo, b"original").unwrap();
        let first = mounted_camera(disk.path(), "Sony", 1).unwrap();
        assert_eq!(first.root.as_deref(), disk.path().join("DCIM").to_str());
        assert_eq!(first.id, mounted_camera(disk.path(), "Sony", 1).unwrap().id);
        assert_ne!(first.id, mounted_camera(disk.path(), "Sony", 2).unwrap().id);
        assert_eq!(std::fs::read(photo).unwrap(), b"original");
    }
    #[test]
    #[ignore = "requires local Windows device inventory; run manually for a read-only smoke test"]
    fn live_discovery() {
        println!("{}", serde_json::to_string(&discover().unwrap()).unwrap());
    }
}

use std::{fs::File, io::BufReader, path::Path};

use chrono::NaiveDateTime;
use exif::{Exif, In, Tag, Value};
use serde::Serialize;

#[derive(Debug, Clone, Default)]
pub struct PhotoMetadata {
    pub captured_at: Option<String>,
    pub date_key: Option<String>,
    pub orientation_degrees: u16,
    pub orientation_mirrored: bool,
    pub exif: Option<ExifSummary>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifSummary {
    pub exposure_time: Option<String>,
    pub aperture: Option<String>,
    pub iso: Option<u32>,
    pub focal_length: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl ExifSummary {
    fn is_empty(&self) -> bool {
        self.exposure_time.is_none()
            && self.aperture.is_none()
            && self.iso.is_none()
            && self.focal_length.is_none()
            && self.camera_model.is_none()
            && self.lens_model.is_none()
            && self.width.is_none()
            && self.height.is_none()
    }
}

pub fn read_photo_metadata(path: &Path) -> PhotoMetadata {
    read_photo_metadata_inner(path).unwrap_or_default()
}

fn read_photo_metadata_inner(path: &Path) -> Option<PhotoMetadata> {
    let file = File::open(path).ok()?;
    let exif = exif::Reader::new()
        .continue_on_error(true)
        .read_from_container(&mut BufReader::new(file))
        .or_else(|error| error.distill_partial_result(|_| {}))
        .ok()?;

    let (captured_at, date_key) = exif_datetime(&exif)
        .map(|(timestamp, date)| (Some(timestamp), Some(date)))
        .unwrap_or_default();
    let (orientation_degrees, orientation_mirrored) = orientation(&exif);
    let summary = ExifSummary {
        exposure_time: rational(&exif, Tag::ExposureTime).map(format_exposure),
        aperture: rational(&exif, Tag::FNumber)
            .map(|value| format!("ƒ/{}", compact_decimal(value))),
        iso: uint(&exif, Tag::PhotographicSensitivity).or_else(|| uint(&exif, Tag::ISOSpeed)),
        focal_length: rational(&exif, Tag::FocalLength)
            .map(|value| format!("{} mm", compact_decimal(value))),
        camera_model: ascii(&exif, Tag::Model),
        lens_model: ascii(&exif, Tag::LensModel),
        width: uint(&exif, Tag::PixelXDimension).or_else(|| uint(&exif, Tag::ImageWidth)),
        height: uint(&exif, Tag::PixelYDimension).or_else(|| uint(&exif, Tag::ImageLength)),
    };

    Some(PhotoMetadata {
        captured_at,
        date_key,
        orientation_degrees,
        orientation_mirrored,
        exif: (!summary.is_empty()).then_some(summary),
    })
}

fn exif_datetime(exif: &Exif) -> Option<(String, String)> {
    let raw = ascii(exif, Tag::DateTimeOriginal).or_else(|| ascii(exif, Tag::DateTime))?;
    let naive = NaiveDateTime::parse_from_str(&raw, "%Y:%m:%d %H:%M:%S").ok()?;
    let offset = ascii(exif, Tag::OffsetTimeOriginal).or_else(|| ascii(exif, Tag::OffsetTime));
    let date_key = naive.format("%Y-%m-%d").to_string();
    let base = naive.format("%Y-%m-%dT%H:%M:%S").to_string();
    let timestamp = offset
        .filter(|value| valid_offset(value))
        .map_or(base.clone(), |value| format!("{base}{value}"));
    Some((timestamp, date_key))
}

fn valid_offset(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 6
        && matches!(bytes[0], b'+' | b'-')
        && bytes[1].is_ascii_digit()
        && bytes[2].is_ascii_digit()
        && bytes[3] == b':'
        && bytes[4].is_ascii_digit()
        && bytes[5].is_ascii_digit()
        && value[1..3].parse::<u8>().is_ok_and(|hours| hours <= 23)
        && value[4..6].parse::<u8>().is_ok_and(|minutes| minutes <= 59)
}

fn orientation(exif: &Exif) -> (u16, bool) {
    let value = uint(exif, Tag::Orientation).unwrap_or(1);
    orientation_from_exif(value)
}

fn orientation_from_exif(value: u32) -> (u16, bool) {
    match value {
        2 => (0, true),
        3 => (180, false),
        4 => (180, true),
        // CSS applies scaleX before rotate: transpose is a mirrored 270° turn.
        5 => (270, true),
        6 => (90, false),
        7 => (90, true),
        8 => (270, false),
        _ => (0, false),
    }
}

fn ascii(exif: &Exif, tag: Tag) -> Option<String> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    let Value::Ascii(values) = &field.value else {
        return None;
    };
    let value = values.first()?;
    let text = String::from_utf8_lossy(value)
        .trim_matches(['\0', ' '])
        .to_owned();
    (!text.is_empty()).then_some(text)
}

fn uint(exif: &Exif, tag: Tag) -> Option<u32> {
    exif.get_field(tag, In::PRIMARY)?.value.get_uint(0)
}

fn rational(exif: &Exif, tag: Tag) -> Option<f64> {
    let field = exif.get_field(tag, In::PRIMARY)?;
    let Value::Rational(values) = &field.value else {
        return None;
    };
    let value = values.first()?;
    (value.denom != 0).then(|| value.to_f64())
}

fn format_exposure(seconds: f64) -> String {
    if seconds > 0.0 && seconds < 1.0 {
        format!("1/{}", (1.0 / seconds).round() as u64)
    } else {
        format!("{} s", compact_decimal(seconds))
    }
}

fn compact_decimal(value: f64) -> String {
    if (value - value.round()).abs() < 0.01 {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_all_exif_orientations() {
        assert_eq!(orientation_from_exif(1), (0, false));
        assert_eq!(orientation_from_exif(2), (0, true));
        assert_eq!(orientation_from_exif(3), (180, false));
        assert_eq!(orientation_from_exif(4), (180, true));
        assert_eq!(orientation_from_exif(5), (270, true));
        assert_eq!(orientation_from_exif(6), (90, false));
        assert_eq!(orientation_from_exif(7), (90, true));
        assert_eq!(orientation_from_exif(8), (270, false));
    }

    #[test]
    fn validates_exif_offsets() {
        assert!(valid_offset("+08:00"));
        assert!(valid_offset("-04:30"));
        assert!(!valid_offset("+8:00"));
        assert!(!valid_offset("+24:00"));
        assert!(!valid_offset("camera"));
    }

    #[test]
    fn formats_common_exposure_values() {
        assert_eq!(format_exposure(1.0 / 640.0), "1/640");
        assert_eq!(format_exposure(2.0), "2 s");
        assert_eq!(compact_decimal(2.8), "2.8");
    }
}

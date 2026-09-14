use std::{fs::File, io::BufReader, path::Path};

use jpeg_decoder::{Decoder, PixelFormat};
use serde::Serialize;
use thiserror::Error;

const HISTOGRAM_BINS: usize = 256;
const DECODE_TARGET: u16 = 512;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewHistogram {
    pub red: Vec<u32>,
    pub green: Vec<u32>,
    pub blue: Vec<u32>,
    pub luminance: Vec<u32>,
    pub sample_count: u64,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Error)]
pub enum PreviewError {
    #[error("无法读取 JPEG 预览：{0}")]
    Io(#[from] std::io::Error),
    #[error("无法解码 JPEG 预览：{0}")]
    Decode(#[from] jpeg_decoder::Error),
    #[error("JPEG 预览缺少图像信息")]
    MissingImageInfo,
    #[error("JPEG 解码后的像素数据不完整")]
    InvalidPixelData,
}

pub fn decode_histogram(path: &Path) -> Result<PreviewHistogram, PreviewError> {
    let (pixels, info) = decode_pixels(path, DECODE_TARGET)?;
    let pixel_bytes = info.pixel_format.pixel_bytes();

    let mut red = vec![0u32; HISTOGRAM_BINS];
    let mut green = vec![0u32; HISTOGRAM_BINS];
    let mut blue = vec![0u32; HISTOGRAM_BINS];
    let mut luminance = vec![0u32; HISTOGRAM_BINS];

    for pixel in pixels.chunks_exact(pixel_bytes) {
        let (r, g, b) = rgb(pixel, info.pixel_format);
        red[usize::from(r)] += 1;
        green[usize::from(g)] += 1;
        blue[usize::from(b)] += 1;
        let y = ((u32::from(r) * 54 + u32::from(g) * 183 + u32::from(b) * 19) >> 8) as u8;
        luminance[usize::from(y)] += 1;
    }

    Ok(PreviewHistogram {
        red,
        green,
        blue,
        luminance,
        sample_count: u64::from(info.width) * u64::from(info.height),
        width: info.width,
        height: info.height,
    })
}

fn decode_pixels(
    path: &Path,
    target: u16,
) -> Result<(Vec<u8>, jpeg_decoder::ImageInfo), PreviewError> {
    let file = File::open(path)?;
    let mut decoder = Decoder::new(BufReader::new(file));
    decoder.set_max_decoding_buffer_size(128 * 1024 * 1024);
    decoder.scale(target, target)?;
    let pixels = decoder.decode()?;
    let info = decoder.info().ok_or(PreviewError::MissingImageInfo)?;
    let pixel_bytes = info.pixel_format.pixel_bytes();
    let expected = usize::from(info.width)
        .saturating_mul(usize::from(info.height))
        .saturating_mul(pixel_bytes);
    if pixels.len() != expected || expected == 0 || pixel_bytes == 0 {
        return Err(PreviewError::InvalidPixelData);
    }

    Ok((pixels, info))
}

pub fn decode_thumbnail(path: &Path) -> Result<Vec<u8>, PreviewError> {
    let (pixels, info) = decode_pixels(path, 256)?;
    Ok(thumbnail_bmp(&pixels, info))
}

fn thumbnail_bmp(pixels: &[u8], info: jpeg_decoder::ImageInfo) -> Vec<u8> {
    // A bounded, uncompressed BMP avoids another codec dependency. EXIF is applied by the UI.
    let scale = (256.0 / f64::from(info.width.max(info.height))).min(1.0);
    let width = (f64::from(info.width) * scale).round().max(1.0) as usize;
    let height = (f64::from(info.height) * scale).round().max(1.0) as usize;
    let stride = (width * 3 + 3) & !3;
    let mut bmp = vec![0u8; 54 + stride * height];
    bmp[..2].copy_from_slice(b"BM");
    let length = bmp.len() as u32;
    bmp[2..6].copy_from_slice(&length.to_le_bytes());
    bmp[10..14].copy_from_slice(&54u32.to_le_bytes());
    bmp[14..18].copy_from_slice(&40u32.to_le_bytes());
    bmp[18..22].copy_from_slice(&(width as i32).to_le_bytes());
    bmp[22..26].copy_from_slice(&(-(height as i32)).to_le_bytes());
    bmp[26..28].copy_from_slice(&1u16.to_le_bytes());
    bmp[28..30].copy_from_slice(&24u16.to_le_bytes());
    for y in 0..height {
        for x in 0..width {
            let offset = ((y * usize::from(info.height) / height) * usize::from(info.width)
                + x * usize::from(info.width) / width)
                * info.pixel_format.pixel_bytes();
            let (r, g, b) = rgb(&pixels[offset..], info.pixel_format);
            let output = 54 + y * stride + x * 3;
            bmp[output..output + 3].copy_from_slice(&[b, g, r]);
        }
    }
    bmp
}

fn rgb(pixel: &[u8], format: PixelFormat) -> (u8, u8, u8) {
    match format {
        PixelFormat::L8 => (pixel[0], pixel[0], pixel[0]),
        PixelFormat::L16 => {
            let value = pixel[0];
            (value, value, value)
        }
        PixelFormat::RGB24 => (pixel[0], pixel[1], pixel[2]),
        PixelFormat::CMYK32 => {
            let c = u16::from(pixel[0]);
            let m = u16::from(pixel[1]);
            let y = u16::from(pixel[2]);
            let k = u16::from(pixel[3]);
            let convert = |component: u16| (((255 - component) * (255 - k)) / 255) as u8;
            (convert(c), convert(m), convert(y))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnail_is_bounded_top_down_bgr_with_padded_rows() {
        let info = jpeg_decoder::ImageInfo {
            width: 3,
            height: 2,
            pixel_format: PixelFormat::RGB24,
            coding_process: jpeg_decoder::CodingProcess::DctSequential,
        };
        let pixels = [
            255, 0, 0, 0, 255, 0, 0, 0, 255, 20, 30, 40, 50, 60, 70, 80, 90, 100,
        ];
        let bmp = thumbnail_bmp(&pixels, info);
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(bmp.len(), 54 + 12 * 2);
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -2);
        assert_eq!(&bmp[54..63], &[0, 0, 255, 0, 255, 0, 255, 0, 0]);
        assert_eq!(&bmp[66..69], &[40, 30, 20]);
        let info = jpeg_decoder::ImageInfo {
            width: 1024,
            height: 512,
            ..info
        };
        let bmp = thumbnail_bmp(&vec![127; 1024 * 512 * 3], info);
        assert_eq!(i32::from_le_bytes(bmp[18..22].try_into().unwrap()), 256);
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -128);
        assert!(bmp.len() < 200_000);
    }

    #[test]
    fn converts_rgb_and_grayscale_pixels() {
        assert_eq!(rgb(&[12, 34, 56], PixelFormat::RGB24), (12, 34, 56));
        assert_eq!(rgb(&[91], PixelFormat::L8), (91, 91, 91));
    }

    #[test]
    fn converts_cmyk_pixels() {
        assert_eq!(rgb(&[0, 255, 255, 0], PixelFormat::CMYK32), (255, 0, 0));
        assert_eq!(rgb(&[0, 0, 0, 255], PixelFormat::CMYK32), (0, 0, 0));
    }
}

# RawSift product decisions

RawSift is a Windows-first, open-source photo culling and verified-ingest tool. It keeps the source read-only and lets photographers review lightweight JPEG previews while selected RAW originals are staged in the background.

## Locked product boundaries

- Windows 10 22H2 and Windows 11 x64 first.
- Sony α6700 is the first verified camera. Both MSC and MTP are supported; MSC is recommended for maximum speed.
- Sources are strictly read-only. RawSift never deletes, moves, renames, rates, or rotates files on a camera or card.
- Version 0.1 handles JPEG and Sony ARW only. It does not handle HEIF, video, tethered shooting, camera control, or RAW editing.
- One active session contains one source device and one photographic day. Multiple devices may be discovered, but only one session is active.
- A capture is the logical selection unit. `DSC01234.JPG` and `DSC01234.ARW` are variants of one capture.
- Review states are unreviewed, keep, and reject. A keep immediately enters the background staging queue.
- Import modes are JPEG, RAW, and JPEG+RAW. The session-level mode is remembered and remains visible.
- Sources may be a camera, mounted card/MSC device, or a manually selected local folder.
- Dates prefer EXIF `DateTimeOriginal`, with PTP/file timestamps as fallbacks and an optional photographic-day cutoff.
- Destination paths use a root, a remembered date template, and an optional shoot name. Existing folders may be appended to safely.
- Source filenames remain unchanged unless a different file with the same name already exists. RawSift never overwrites.
- A second destination is optional. Each target is copied, verified, and committed independently.
- Every staged file is hashed while reading, closed, re-read from the destination, and compared before it is eligible to commit.
- Sessions survive application, device, and target interruptions. Resume is file-granular; an interrupted file restarts.
- Import history and content fingerprints persist until the user removes them. Preview cache defaults to a 5 GB LRU budget.

## Review experience

- One main window combines device/date navigation, single-image review, a grid, two-image comparison, and the ingest queue.
- Default review is a large image with a filmstrip. `G` toggles grid and `C` toggles synchronized two-image comparison.
- `P` keeps, `X` rejects, `U` clears, arrows navigate, Space performs focus check, and `Ctrl+Z` undoes. Core shortcuts are remappable.
- Marking keep/reject advances by default; auto-advance can be disabled.
- EXIF and a preview-derived RGB/luminance histogram are independently toggleable.
- EXIF orientation is automatic. Manual rotation is non-destructive local metadata.
- JPEG is the preferred review representation. RAW is decoded on demand when a lower-resolution JPEG cannot support focus inspection.
- The visual system is neutral graphite, compact, image-first, and AA contrast aware. Dark is default; light/system themes remain supported.
- Simplified Chinese and English are first-class languages.

## Safety, privacy, and distribution

- No accounts, photo uploads, usage telemetry, or automatic crash uploads.
- Diagnostics are local, inspectable, and manually exported with identifiers redacted.
- Closing can minimize to the tray or pause and exit; the choice can be remembered. No separate Windows service is installed.
- Updates are checked in-app, signed, user-confirmed, and never installed during active transfers.
- Public Windows installers require Authenticode signing. Installation is per-user and does not require administrator privileges.
- RawSift is licensed under `MIT OR Apache-2.0`. LibRaw is shipped as an isolated decoder dependency under its own license.


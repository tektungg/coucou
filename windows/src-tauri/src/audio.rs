// The Audio pill: output and microphone devices, their volume and mute, the
// default device, and which apps are using the microphone right now.
//
// Core Audio (MMDevice, IAudioEndpointVolume) reads and sets volume and mute.
// Windows has no public API to change the default device; IPolicyConfig is
// the private COM interface the Sound control panel itself uses, and the one
// EarTrumpet and SoundSwitch rely on. Which apps use the microphone comes from
// the same registry keys the taskbar's privacy indicator reads.
//
// Decisions (ordering, rounding, which registry entries mean "in use", app
// names) are pure functions tested below; `imp` only makes the calls.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Level {
    /// 0..1, to the hundredth so a poll does not see noise as a change.
    pub volume: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub outputs: Vec<Device>,
    pub inputs: Vec<Device>,
    pub output: Option<Level>,
    pub input: Option<Level>,
    /// Apps using the microphone now, by name.
    pub mic_users: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Output,
    Input,
}

pub fn parse_flow(flow: &str) -> Result<Flow, String> {
    match flow {
        "output" => Ok(Flow::Output),
        "input" => Ok(Flow::Input),
        other => Err(format!("unknown audio flow {other:?}")),
    }
}

pub(crate) fn round_volume(v: f32) -> f32 {
    if !v.is_finite() {
        return 0.0;
    }
    (v.clamp(0.0, 1.0) * 100.0).round() / 100.0
}

pub(crate) fn clamp_volume(v: f64) -> f32 {
    if v.is_finite() { v.clamp(0.0, 1.0) as f32 } else { 0.0 }
}

/// The default device first, then by name, so the list does not jump.
pub(crate) fn order_devices(mut devices: Vec<Device>) -> Vec<Device> {
    devices.sort_by(|a, b| b.is_default.cmp(&a.is_default).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    devices
}

/// One app's entry under ConsentStore\microphone.
#[derive(Debug, Clone)]
pub(crate) struct MicEntry {
    /// The subkey name: a package family name, or for desktop apps the exe
    /// path with `#` for `\`.
    pub key: String,
    pub packaged: bool,
    pub last_start: u64,
    pub last_stop: u64,
}

/// A name a person recognises: "C:#Program Files#Discord#app-1.0#Discord.exe"
/// → "Discord", "Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe" → "Sound Recorder".
pub(crate) fn mic_app_label(key: &str, packaged: bool) -> String {
    if !packaged {
        let file = key.rsplit(['#', '\\']).next().unwrap_or(key);
        let stem = file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(file);
        const KNOWN: &[(&str, &str)] = &[
            ("discord", "Discord"),
            ("zoom", "Zoom"),
            ("ms-teams", "Teams"),
            ("teams", "Teams"),
            ("slack", "Slack"),
            ("chrome", "Chrome"),
            ("msedge", "Edge"),
            ("firefox", "Firefox"),
            ("obs64", "OBS"),
            ("whatsapp", "WhatsApp"),
            ("telegram", "Telegram"),
            ("zen", "Zen"),
            ("brave", "Brave"),
            ("opera", "Opera"),
            ("arc", "Arc"),
            ("vivaldi", "Vivaldi"),
        ];
        let lower = stem.to_ascii_lowercase();
        return KNOWN
            .iter()
            .find(|(needle, _)| lower == *needle || lower.starts_with(needle))
            .map(|(_, name)| (*name).to_string())
            .unwrap_or_else(|| capitalized(stem));
    }
    let family = key.split('_').next().unwrap_or(key);
    const PACKAGED: &[(&str, &str)] = &[
        ("Microsoft.WindowsSoundRecorder", "Sound Recorder"),
        ("MSTeams", "Teams"),
        ("MicrosoftTeams", "Teams"),
        ("5319275A.WhatsAppDesktop", "WhatsApp"),
        ("Microsoft.WindowsCamera", "Camera"),
        ("Microsoft.ScreenSketch", "Snipping Tool"),
    ];
    if let Some((_, name)) = PACKAGED.iter().find(|(id, _)| family.eq_ignore_ascii_case(id)) {
        return (*name).to_string();
    }
    // "Publisher.AppName" → "AppName".
    family.rsplit('.').next().unwrap_or(family).to_string()
}

/// Noise removal and mixing apps hold the physical microphone all the time
/// to feed their virtual one; the app actually listening (Discord on
/// "NVIDIA Broadcast" as input) is what counts.
const MIC_PROCESSORS: &[&str] = &[
    "nvidia broadcast",
    "nvidia rtx voice",
    "krisp",
    "voicemeeter",
    "wavelink",
    "wave link",
    "steelseriessonar",
    "sonar",
    "audiodg",
];

pub(crate) fn is_mic_processor(key: &str) -> bool {
    let file = key.rsplit(['#', '\\']).next().unwrap_or(key).to_ascii_lowercase();
    let stem = file.strip_suffix(".exe").unwrap_or(&file);
    MIC_PROCESSORS.iter().any(|p| stem == *p || stem.starts_with(p))
}

/// "recorder" → "Recorder"; a name with its own capitals is left alone.
fn capitalized(name: &str) -> String {
    if name.chars().any(|c| c.is_uppercase()) {
        return name.to_string();
    }
    let mut chars = name.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// The apps using the microphone now: an entry whose last use started and
/// has not stopped, mic processors left out. Sorted, each named once.
pub(crate) fn mic_users(entries: &[MicEntry]) -> Vec<String> {
    let mut names: Vec<String> = entries
        .iter()
        .filter(|e| e.last_start != 0 && e.last_stop == 0 && !is_mic_processor(&e.key))
        .map(|e| mic_app_label(&e.key, e.packaged))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names
}

#[cfg(windows)]
pub use imp::{set_default, set_mute, set_volume, snapshot};

#[cfg(not(windows))]
pub fn snapshot() -> Result<Snapshot, String> {
    Err("Audio is Windows only for now".into())
}

#[cfg(not(windows))]
pub fn set_default(_id: &str) -> Result<(), String> {
    Err("Audio is Windows only for now".into())
}

#[cfg(not(windows))]
pub fn set_volume(_flow: Flow, _volume: f32) -> Result<(), String> {
    Err("Audio is Windows only for now".into())
}

#[cfg(not(windows))]
pub fn set_mute(_flow: Flow, _muted: bool) -> Result<(), String> {
    Err("Audio is Windows only for now".into())
}

// The COM methods keep Windows' names: IPolicyConfig is matched by vtable order.
#[cfg(windows)]
#[allow(non_snake_case)]
mod imp {
    use std::ffi::c_void;

    use ::windows::core::{Interface, GUID, HRESULT, HSTRING, PCWSTR, PWSTR};
    use ::windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use ::windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use ::windows::Win32::Media::Audio::{
        eCapture, eCommunications, eConsole, eMultimedia, eRender, EDataFlow, ERole, IMMDevice, IMMDeviceEnumerator,
        MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use ::windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
    };
    use ::windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };

    use super::{order_devices, round_volume, Device, Flow, Level, MicEntry, Snapshot};

    /// The Sound control panel's own interface for the default device.
    #[::windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    unsafe trait IPolicyConfig: ::windows::core::IUnknown {
        fn GetMixFormat(&self, id: PCWSTR, format: *mut *mut c_void) -> HRESULT;
        fn GetDeviceFormat(&self, id: PCWSTR, default: i32, format: *mut *mut c_void) -> HRESULT;
        fn ResetDeviceFormat(&self, id: PCWSTR) -> HRESULT;
        fn SetDeviceFormat(&self, id: PCWSTR, endpoint: *mut c_void, mix: *mut c_void) -> HRESULT;
        fn GetProcessingPeriod(&self, id: PCWSTR, default: i32, period: *mut i64, min: *mut i64) -> HRESULT;
        fn SetProcessingPeriod(&self, id: PCWSTR, period: *mut i64) -> HRESULT;
        fn GetShareMode(&self, id: PCWSTR, mode: *mut c_void) -> HRESULT;
        fn SetShareMode(&self, id: PCWSTR, mode: *mut c_void) -> HRESULT;
        fn GetPropertyValue(&self, id: PCWSTR, key: *const c_void, value: *mut c_void) -> HRESULT;
        fn SetPropertyValue(&self, id: PCWSTR, key: *const c_void, value: *mut c_void) -> HRESULT;
        fn SetDefaultEndpoint(&self, id: PCWSTR, role: ERole) -> HRESULT;
        fn SetEndpointVisibility(&self, id: PCWSTR, visible: i32) -> HRESULT;
    }

    const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

    fn err(what: &str, e: ::windows::core::Error) -> String {
        format!("{what}: {}", e.message())
    }

    fn com() {
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    }

    fn enumerator() -> Result<IMMDeviceEnumerator, String> {
        com();
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(|e| err("audio devices", e))
    }

    fn take_pwstr(p: PWSTR) -> String {
        unsafe {
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        }
    }

    fn device_id(device: &IMMDevice) -> Option<String> {
        unsafe { device.GetId().ok().map(take_pwstr) }
    }

    fn device_name(device: &IMMDevice) -> String {
        unsafe {
            device
                .OpenPropertyStore(STGM_READ)
                .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
                .map(|v| v.to_string())
                .unwrap_or_default()
        }
    }

    fn data_flow(flow: Flow) -> EDataFlow {
        match flow {
            Flow::Output => eRender,
            Flow::Input => eCapture,
        }
    }

    fn default_device(e: &IMMDeviceEnumerator, flow: Flow) -> Option<IMMDevice> {
        unsafe { e.GetDefaultAudioEndpoint(data_flow(flow), eConsole).ok() }
    }

    fn devices(e: &IMMDeviceEnumerator, flow: Flow) -> Vec<Device> {
        let default_id = default_device(e, flow).and_then(|d| device_id(&d));
        let mut out = Vec::new();
        unsafe {
            let Ok(list) = e.EnumAudioEndpoints(data_flow(flow), DEVICE_STATE_ACTIVE) else {
                return out;
            };
            let count = list.GetCount().unwrap_or(0);
            for i in 0..count {
                let Ok(device) = list.Item(i) else { continue };
                let Some(id) = device_id(&device) else { continue };
                out.push(Device { is_default: default_id.as_deref() == Some(id.as_str()), name: device_name(&device), id });
            }
        }
        order_devices(out)
    }

    fn endpoint_volume(e: &IMMDeviceEnumerator, flow: Flow) -> Option<IAudioEndpointVolume> {
        let device = default_device(e, flow)?;
        unsafe { device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).ok() }
    }

    fn level(e: &IMMDeviceEnumerator, flow: Flow) -> Option<Level> {
        let volume = endpoint_volume(e, flow)?;
        unsafe {
            Some(Level {
                volume: round_volume(volume.GetMasterVolumeLevelScalar().ok()?),
                muted: volume.GetMute().map(|b| b.as_bool()).unwrap_or(false),
            })
        }
    }

    /// Blocking COM and registry calls; the caller runs it in spawn_blocking.
    pub fn snapshot() -> Result<Snapshot, String> {
        let e = enumerator()?;
        Ok(Snapshot {
            outputs: devices(&e, Flow::Output),
            inputs: devices(&e, Flow::Input),
            output: level(&e, Flow::Output),
            input: level(&e, Flow::Input),
            mic_users: super::mic_users(&mic_entries()),
        })
    }

    pub fn set_volume(flow: Flow, volume: f32) -> Result<(), String> {
        let e = enumerator()?;
        let v = endpoint_volume(&e, flow).ok_or("No audio device")?;
        unsafe { v.SetMasterVolumeLevelScalar(volume, std::ptr::null()) }.map_err(|e| err("volume", e))
    }

    pub fn set_mute(flow: Flow, muted: bool) -> Result<(), String> {
        let e = enumerator()?;
        let v = endpoint_volume(&e, flow).ok_or("No audio device")?;
        unsafe { v.SetMute(muted, std::ptr::null()) }.map_err(|e| err("mute", e))
    }

    /// Makes `id` the default device for every role (system sounds, media, calls).
    pub fn set_default(id: &str) -> Result<(), String> {
        com();
        let policy: IPolicyConfig =
            unsafe { CoCreateInstance(&CLSID_POLICY_CONFIG_CLIENT, None, CLSCTX_ALL) }.map_err(|e| err("audio policy", e))?;
        let wide = HSTRING::from(id);
        for role in [eConsole, eMultimedia, eCommunications] {
            unsafe { policy.SetDefaultEndpoint(PCWSTR(wide.as_ptr()), role) }
                .ok()
                .map_err(|e| err("default device", e))?;
        }
        let _ = policy.as_raw();
        Ok(())
    }

    // ── Who uses the microphone ──────────────────────────────────────────────

    const CONSENT: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            let _ = unsafe { RegCloseKey(self.0) };
        }
    }

    fn open(parent: HKEY, path: &str) -> Option<Key> {
        let mut key = HKEY::default();
        let wide = HSTRING::from(path);
        unsafe { RegOpenKeyExW(parent, &wide, None, KEY_READ, &mut key) }.ok().ok()?;
        Some(Key(key))
    }

    fn subkeys(key: &Key) -> Vec<String> {
        let mut out = Vec::new();
        let mut i = 0u32;
        loop {
            let mut name = [0u16; 512];
            let mut len = name.len() as u32;
            let r = unsafe { RegEnumKeyExW(key.0, i, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None) };
            if r.is_err() {
                break;
            }
            out.push(String::from_utf16_lossy(&name[..len as usize]));
            i += 1;
        }
        out
    }

    fn qword(key: &Key, name: &str) -> u64 {
        let wide = HSTRING::from(name);
        let mut value = [0u8; 8];
        let mut len = 8u32;
        let r = unsafe { RegQueryValueExW(key.0, &wide, None, None, Some(value.as_mut_ptr()), Some(&mut len)) };
        if r.is_err() || len != 8 {
            return 0;
        }
        u64::from_le_bytes(value)
    }

    fn entry(parent: &Key, name: &str, packaged: bool) -> Option<MicEntry> {
        let key = open(parent.0, name)?;
        Some(MicEntry {
            key: name.to_string(),
            packaged,
            last_start: qword(&key, "LastUsedTimeStart"),
            last_stop: qword(&key, "LastUsedTimeStop"),
        })
    }

    fn mic_entries() -> Vec<MicEntry> {
        let Some(root) = open(HKEY_CURRENT_USER, CONSENT) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for name in subkeys(&root) {
            if name.eq_ignore_ascii_case("NonPackaged") {
                if let Some(np) = open(root.0, &name) {
                    out.extend(subkeys(&np).iter().filter_map(|app| entry(&np, app, false)));
                }
            } else if let Some(e) = entry(&root, &name, true) {
                out.push(e);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(id: &str, name: &str, is_default: bool) -> Device {
        Device { id: id.into(), name: name.into(), is_default }
    }

    fn mic(key: &str, packaged: bool, start: u64, stop: u64) -> MicEntry {
        MicEntry { key: key.into(), packaged, last_start: start, last_stop: stop }
    }

    #[test]
    fn flows() {
        assert_eq!(parse_flow("output"), Ok(Flow::Output));
        assert_eq!(parse_flow("input"), Ok(Flow::Input));
        assert!(parse_flow("both").is_err());
    }

    #[test]
    fn volumes_round_and_clamp() {
        assert_eq!(round_volume(0.623_4), 0.62);
        assert_eq!(round_volume(1.2), 1.0);
        assert_eq!(round_volume(-0.1), 0.0);
        assert_eq!(round_volume(f32::NAN), 0.0);
        assert_eq!(clamp_volume(0.5), 0.5);
        assert_eq!(clamp_volume(7.0), 1.0);
        assert_eq!(clamp_volume(f64::INFINITY), 0.0);
    }

    #[test]
    fn default_device_first_then_by_name() {
        let ordered = order_devices(vec![d("3", "speakers", false), d("1", "Headphones", true), d("2", "HDMI", false)]);
        let names: Vec<&str> = ordered.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["Headphones", "HDMI", "speakers"]);
    }

    #[test]
    fn mic_in_use_means_started_and_not_stopped() {
        let entries = vec![
            mic(r"C:#Users#me#AppData#Local#Discord#app-1.0.9#Discord.exe", false, 100, 0),
            mic(r"C:#Program Files#Zoom#bin#Zoom.exe", false, 100, 200),
            mic("Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe", true, 0, 0),
            mic("MSTeams_8wekyb3d8bbwe", true, 300, 0),
        ];
        assert_eq!(mic_users(&entries), vec!["Discord".to_string(), "Teams".to_string()]);
        assert!(mic_users(&[]).is_empty());
    }

    /// What this machine had: Broadcast holding the mic all day, Discord on a call.
    #[test]
    fn mic_processors_do_not_count() {
        let entries = vec![
            mic(r"C:#Program Files#NVIDIA Corporation#NVIDIA Broadcast#NVIDIA Broadcast.exe", false, 100, 0),
            mic(r"C:#Users#me#AppData#Local#Discord#app-1.0.9#Discord.exe", false, 100, 0),
            mic(r"C:#Program Files#VB#Voicemeeter#voicemeeter8x64.exe", false, 100, 0),
            mic(r"C:#Program Files#Krisp#krisp.exe", false, 100, 0),
        ];
        assert_eq!(mic_users(&entries), vec!["Discord".to_string()]);
        assert!(!is_mic_processor(r"C:#Program Files#Zoom#bin#Zoom.exe"));
    }

    #[test]
    fn the_same_app_twice_is_named_once() {
        let entries = vec![
            mic(r"C:#Program Files#Google#Chrome#Application#chrome.exe", false, 1, 0),
            mic(r"C:#Program Files (x86)#Google#Chrome#Application#chrome.exe", false, 1, 0),
        ];
        assert_eq!(mic_users(&entries), vec!["Chrome".to_string()]);
    }

    #[test]
    fn app_labels() {
        assert_eq!(mic_app_label(r"C:#Program Files#obs-studio#bin#64bit#obs64.exe", false), "OBS");
        assert_eq!(mic_app_label(r"C:#Tools#recorder.EXE", false), "Recorder");
        assert_eq!(mic_app_label(r"C:#Program Files#Zen Browser#zen.exe", false), "Zen");
        assert_eq!(mic_app_label(r"C:#Tools#myTool.exe", false), "myTool");
        assert_eq!(mic_app_label("Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe", true), "Sound Recorder");
        assert_eq!(mic_app_label("5319275A.WhatsAppDesktop_cv1g1gvanyjgm", true), "WhatsApp");
        assert_eq!(mic_app_label("SomePublisher.CoolApp_abc123", true), "CoolApp");
    }

    #[test]
    fn snapshot_serializes_camel_case() {
        let s = Snapshot {
            outputs: vec![d("a", "Speakers", true)],
            inputs: vec![],
            output: Some(Level { volume: 0.5, muted: false }),
            input: None,
            mic_users: vec!["Discord".into()],
        };
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["outputs"][0]["isDefault"], true);
        assert_eq!(json["output"]["volume"], 0.5);
        assert_eq!(json["micUsers"][0], "Discord");
        assert!(json["input"].is_null());
    }

    /// Live eval: devices listed with one default each, the current default
    /// output set again (a no-op that proves IPolicyConfig works), the mic
    /// users counted. Prints counts only.
    #[test]
    #[ignore]
    fn audio_live() {
        let s = snapshot().expect("snapshot");
        println!(
            "audio_live: outputs={} inputs={} output={:?} input={:?} mic_users={}",
            s.outputs.len(),
            s.inputs.len(),
            s.output,
            s.input,
            s.mic_users.len()
        );
        assert!(!s.outputs.is_empty());
        assert_eq!(s.outputs.iter().filter(|x| x.is_default).count(), 1);
        assert!(s.outputs[0].is_default, "default first");
        let current = s.outputs[0].id.clone();
        set_default(&current).expect("set the same default again");
        let again = snapshot().unwrap();
        assert_eq!(again.outputs[0].id, current);
    }
}

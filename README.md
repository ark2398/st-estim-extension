# ESTIM Immersion Extension for SillyTavern

**Bring your roleplay to life with synchronized electrostimulation (E-Stim).**

This extension allows the AI in SillyTavern to seamlessly and dynamically trigger physical electrostimulation signals on your local hardware based on the narrative context. It translates the story's events into audio signals, which can be interpreted by audio-responsive e-stim devices (like 2B, 3rdH, et312b, DIY stereostim units, etc.).

---

> **🔞 18+ / NSFW Warning & Disclaimer**
> This extension is designed to interface with physical e-stim hardware for maximum immersion in roleplay scenarios. While the default code and profiles provided in this repository are strictly technical and functional, the nature of this hardware implies it may be used by adults in mature or NSFW contexts. Please use your hardware responsibly, follow the manufacturer's safety guidelines, and never use e-stim equipment above the waist or across the chest. **Use at your own risk.**

---

## ✨ Features

* **Intelligent LLM Integration:** Uses native AI Tool Calling (`inflict_physical_sensation`). The AI automatically reads the context (e.g., a character pinching or shocking you) and triggers the appropriate physical sensation.
* **Smart Duration & Pacing:** LLMs are bad at math. Instead of guessing seconds, the AI can specify relative durations (e.g., `"100%"`) that automatically calculate and scale to the exact reading time of its generated response, adjusted by your personal "Duration Pacing Factor".
* **Stereo Channel Targeting:** The AI can actively isolate sensations to a specific body part by routing the audio strictly to the Left (CH 1) or Right (CH 2) audio channel, or stimulate both simultaneously for full-body immersion.
* **Simultaneous Device Profiles:** E-stim hardware feels different depending on the device and electrode placement. You can select and combine multiple "Profiles" via checkboxes to map specific audio tracks to subjective sensations.
* **Automatic State Awareness (Dynamic Macros):** The AI always knows exactly what the hardware is currently doing (running indefinitely, stopped, intensity, remaining time). The extension provides an `{{estim_state}}` macro that dynamically tracks telemetry without cluttering the chat history.
* **Smart "Stop" Logic:** The AI can actively decide to stop a stimulation by calling the tool with the built-in `stop` pattern or setting the intensity to `0`.
* **100% Local & Secure:** No external APIs, no cloud tracking. Everything runs locally and audio files are lazy-loaded into memory for instant, lag-free playback.

## ⚙️ How It Works

1. The AI decides you should feel a specific sensation based on the story.
2. It calls the `inflict_physical_sensation` function in stealth mode.
3. The extension intercepts this call, calculates the necessary timings, and plays a specific, pre-loaded audio file in your browser.
4. Your e-stim hardware (connected via your audio jack/Bluetooth) translates this stereo audio frequency and volume into electrical impulses.

## 🚀 Installation

1. Open your SillyTavern interface.
2. Go to the **Extensions** menu (the block icon).
3. Click **Install Extension**.
4. Paste the link to this GitHub repository (`[https://github.com/ark2398/st-estim-extension](https://github.com/ark2398/st-estim-extension)`) and click install.
5. Reload SillyTavern.
6. Populate the folder `profiles-local` with your stereostim audio files. It is a good idea to have a separate subdirectory for each profile.
7. Create a new profile `profiles.json` for the added audio files. Make sure that each sensation has a rich and vivid description. The LLM will select the sensation based on that description. Follow the example.
8. Add your new profile to the profiles list (`profiles.json`).

## 🎮 Usage

**⚠️ IMPORTANT: First Run Calibration**
For safety reasons, the extension defaults to 0% output volume on a fresh installation to prevent accidental high-intensity signals. **The hardware remains locked and will not output any audio until you complete the calibration.** To calibrate, you must first load at least one profile and run
the `/estim-calibrate` command.

**Step 1: Hardware & Profiles (Prerequisites)**
1. Connect your audio-responsive e-stim device to your PC/Device's audio output. **Turn the physical volume dial on your e-stim unit to the lowest setting!**
2. Open the **Extensions Settings** in SillyTavern and find the **ESTIM Immersion** section.
3. Select one or more hardware setups from the **Active Device Profiles** list using the checkboxes. This loads the audio patterns required for calibration.
4. Enter your electrode placements in the **CH 1** and **CH 2** fields (e.g., "left arm", "lower back").

**Step 2: Unlock via Calibration**
1. Turn the physical volume dial on your e-stim unit to an acceptable amplification level. (From 
your own experience.)
2. In the SillyTavern chat input, type `/estim-calibrate pattern=` and select the desired pattern to use for calibration from the list. Then press Enter.
3. The Restricted Remote Control will open on your screen.
4. Set all sliders to the left, then slowly increase the sliders and use the `▶` play buttons to test the minimum feeling (threshold), the maximum pleasure limit, and your absolute pain limit. 
5. Click **Save Calibration**. This saves the calibration values into the settings and permanently unlocks the extension.

**Step 3: Gameplay Setup**
1. Adjust the **Duration Pacing Factor** in the settings (Default: 1.5) to stretch or shorten the stimulation time per generated word according to your reading speed.
2. Start roleplaying!

### Manual Commands

You can manually test signals or toggle profiles using the chat input:

* `/estim pattern=profile_name/pattern_name intensity=50 duration=0 target_channel=ch1`
* `/estim-profile profile_name` (Toggles a profile on/off)

---

## 🧠 Prompt Engineering (Highly Recommended)

Modern LLMs (like Claude, Llama 3, or GPT-4) respond best to structured XML tags. To get the most immersive experience and prevent the AI from "God-Moding" (telling you *how* you feel instead of letting the hardware do it), we highly recommend adding the following blocks to your SillyTavern setup.

### 1. The Core Instructions (System Prompt)

Paste this XML block directly into your **System Prompt** (<instruction>) or a highly weighted **Author's Note**.

```xml
<estim_immersion_engine>
Tool Name: inflict_physical_sensation
- The Connection: The player is physically connected to an e-stim device on {{estim_ch1}} and {{estim_ch2}}. 
- The Trigger: IT IS CRITICAL FOR THE IMMERSION that you call the tool whenever the story narrates that {{user}} receives electrical stimulation from devices like implants, electro stimulation devices, shock devices, currents, or any other electrical play. RESTRICT this tool STRICTLY to electrical stimulation. For pure mechanical acts, use standard text narration only.
- Action vs. Narration: Describe the source, but do not narrate how it physically feels. Let the tool do the work. However NEVER reply only with the tool call.
- Pattern Selection: Use the self-descriptive pattern names. You may use pain stimulation whenever appropriate. 
- Intensity Rules: 10-30 (Gentle tease), 50-80 (Strong vibration), ~100 (Climax forcing), 150+ (Cruel shock). Build intensity slowly over multiple turns unless delivering sudden punishment. Keep below 80 for non-climax actions.
- Duration Rules: Use "100%" for background sensations accompanying your dialogue. Use short numbers (e.g., "1", "2") for sudden impacts. Use "0" to play the sensation exactly once for its native length. Use "-1" to loop the sensation infinitely if leaving the device running while waiting for the player's reply.
- Remote Control UI: Keep all UI modules disabled by default to enforce helplessness. Use 'trick_or_treat' for secret Russian Roulette choices to play sadistic games to the player. Use 'stop_module' as a psychological taunt or safety button. Use 'calibration_module' for calibration. Set increase_only=true to build a sadistic calibration trap.
- Execution Rules: Call the tool strictly ONCE per response, at the very end of your output. It is a 'fire and forget' function. LIMIT: Maximum ONE tool call per turn.
- State Management (CRITICAL): Your past calls are invisible in the chat history. Do not let this confuse you. To verify the active sensation, you MUST read the <estim_immersion_state></estim_immersion_state> block injected right before your turn. If your last action has finished naturally, narrate the aftermath. If a sensation is currently running, actively decide whether to maintain, change, or stop it using the tool.
</estim_immersion_engine>
```

### 2. State Awareness Injection (Author's Note / Depth 0)

Because tool calls are invisible in the chat history, the AI needs a reminder of what the hardware is actively doing. The extension provides a dynamic macro (`{{estim_state}}`) for this.

Add this snippet to your **Author's Note** (set to "In Chat" at Depth 0 or 1, so it appears right before the AI's turn):

```xml
<estim_immersion_state>
The e-stim device on the player reports the following real-time telemetry:
{{estim_state}}
</estim_immersion_state>

```

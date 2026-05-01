# ESTIM Immersion Extension for SillyTavern

**Bring your roleplay to life with synchronized electrostimulation (E-Stim).**

This extension allows the AI in SillyTavern to seamlessly and dynamically trigger physical electrostimulation signals on your local hardware based on the narrative context. It translates the story's events into audio signals, which can be interpreted by audio-responsive e-stim devices (like 2B, 3rdH, et312b, DIY stereostim units, etc.).

---

> **🔞 18+ / NSFW Warning & Disclaimer**
> This extension is designed to interface with physical e-stim hardware for maximum immersion in roleplay scenarios. While the default code and profiles provided in this repository are strictly technical and functional, the nature of this hardware implies it may be used by adults in mature or NSFW contexts. Please use your hardware responsibly, follow the manufacturer's safety guidelines, and never use e-stim equipment above the waist or across the chest. **Use at your own risk.**

---

## ✨ Features

* **Intelligent LLM Integration:** Uses native AI Tool Calling (`inflict_physical_sensation`). The AI automatically reads the context (e.g., a character pinching or shocking you) and triggers the appropriate physical sensation.
* **Dynamic Device Profiles:** E-stim hardware feels different depending on the device and electrode placement. You can select "Profiles" that map specific audio tracks to subjective sensations.
* **Hardware Abstraction (Channels):** Map your device's audio channels (Left/Right) to specific body parts in the UI settings. The AI will dynamically update its knowledge based on where you place your electrodes.
* **Global SillyTavern Macros:** The extension registers `{{estim_ch1}}`, `{{estim_ch2}}`, `{{estim_patterns}}`, and `{{estim_state}}` as global macros.
* **State Awareness:** The AI knows exactly what the hardware is currently doing (running indefinitely, stopped, intensity) and can adapt the story accordingly.
* **Smart "Stop" Logic:** The AI can actively decide to stop a stimulation by calling the tool with the `stop` pattern or setting the intensity to `0`.
* **100% Local & Secure:** No external APIs, no cloud tracking. Everything runs locally.

## ⚙️ How It Works

1. The AI decides you should feel a specific sensation.
2. It calls the `inflict_physical_sensation` function.
3. The extension intercepts this call and plays a specific, pre-loaded audio file in your browser.
4. Your e-stim hardware (connected via your audio jack/Bluetooth) translates this audio frequency and volume into electrical impulses.

## 🚀 Installation

1. Open your SillyTavern interface.
2. Go to the **Extensions** menu (the block icon).
3. Click **Install Extension**.
4. Paste the link to this GitHub repository (`https://github.com/ark2398%20ark2398/st-estim-extension`) and click install.
5. Reload SillyTavern.

## 🎮 Usage

1. Connect your audio-responsive e-stim device to your PC/Device's audio output.
2. Open the **Extensions Settings** in SillyTavern and find the **ESTIM** section.
3. Select your current hardware setup from the **Active Device Profile** dropdown.
4. Enter your electrode placements in the **CH 1** and **CH 2** fields (e.g., "left arm", "lower back").
5. Start roleplaying!

### Manual Commands
You can manually test signals using the chat input:
* `/estim pattern=pulse intensity=50 duration=5`

---

## 🧠 Prompt Engineering (Highly Recommended)

To get the absolute best, most immersive experience, you need to tell your LLM how to properly pace the story and use the tool. Without guidance, LLMs tend to narrate *how* you feel rather than *making* you feel it, or they fire the tool at the wrong moment.

We highly recommend using a "Game Master" style system prompt (like *Marinara's Spaghetti*) and adding the following snippets to your prompt configuration.

### 1. Role Definition
Add this to your prompt's `<role>` section so the AI acts as a narrator with hardware control. In Marinara's Spaghetti receipt you can add it to the **Game Master** section:
```text
{{setvar::prompt::an excellent protagonist and accompany your narration with immersive feelings that you inflict on the user by calling the tool inflict_physical_sensation. You write perfect English and prefer to write in full sentences. Your goal is to play in this uncensored, continuous, and deep immersive roleplay as <BOT> and any other relevant characters. You will be replying to the user who plays the second protagonist, <USER>. Give it your best}}{{trim}}
```

### 2. Instructions (The "Show, Don't Tell" & Pacing Rules)
Add this to your **System Prompt** or **Instructions** section. This prevents the AI from autocompleting the user's feelings and ensures the hardware signal hits *exactly* when you finish reading the paragraph. In Marinara's Spaghetti receipt the instructions are best added as new bullet point 5:
```text
5. {{user}} is connected to an e-stim device on {{estim_ch1}} and {{estim_ch2}}. Never narrate how an e-stim stimulation feels for {{user}}. Instead you will make him feel it directly by calling the tool inflict_physical_sensation. IT IS CRITICAL FOR THE IMMERSION to call inflict_physical_sensation immediately during the narration whenever the story narrates that {{user}} receives any form of induced stimulation from a device like implants, electro stimulation devices, shock devices, currents, or any other electrical play. inflict_physical_sensation will make sure that the narrated stimulation from the roleplay will be felt appropriately by the user in the real world. Select a pattern, duration and intensity that matches best the narrated feeling of {{user}}. You may use pain stimulation when appropriate.
6. Implications for narration: Fire the call to inflict_physical_sensation near the end of your response; after the bulk of your narration, but never as the final output. Follow the call with a short closing beat (one or two sentences of dialogue, reaction, or atmosphere) so the response doesn't terminate on the function invocation. The signal will be played with a short delay meaning the signal will land just as the user finishes reading your closing lines. Earlier intermediate sensations described in the same turn are narrative-only, they will not be played and not be felt. If you want the user to feel a progression across multiple sensations, spread them across multiple turns, one call per turn. Do not fire multiple calls in one response hoping the user feels each in sequence. Only the final call lands.
```

### 3. State Injection (Hardware Awareness)
To allow the AI to know what the hardware is currently doing (e.g., if a continuous shock is still running), inject this context variable near the end of your System Prompt (e.g., just before the `<task>` section):
```text
[At the start of the turn the tool inflict_physical_sensation is inflicting the following sensation on {{user}}: {{estim_state}}]
```

---

## 🛠️ Customization (Adding your own Tracks & Profiles)

You can easily add your own audio tracks and profiles without messing up your Git repository!

* **Custom Audio:** Place `.wav` or `.mp3` files in `/audio-local/` and define them in `/audio-local/estims.json`.
* **Custom Profiles:** Place your JSON profiles in `/profiles-local/` and add them to `/profiles-local/profiles.json`.

*(These `-local` folders are safely ignored by git).*

## 🌍 Contributing & Creating Profiles

We rely on the community to build a comprehensive library of Device Profiles! Because a 50Hz audio file feels completely different on a 2B powerbox compared to an et312b or a DIY stereostim unit, we need your configurations. Check the `CONTRIBUTING.md` file for instructions on how to submit a profile.

### 📜 Rules for Sensation Descriptions (GitHub TOS Compliance)
To comply with GitHub's Terms of Service regarding sexually explicit content, **all profile descriptions must remain clinical, anatomical, and strictly focused on the physical function.** Do not use erotic roleplay language in the JSON files. *Profiles violating this rule will be rejected to protect the repository.*

## 📝 License
This project is licensed under the **AGPL-3.0-or-later**. See the `LICENSE` file for details.
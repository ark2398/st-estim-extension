ESTIM Immersion Extension for SillyTavern
Bring your roleplay to life with synchronized electrostimulation (E-Stim).

This extension allows the AI in SillyTavern to seamlessly and dynamically trigger physical electrostimulation signals on your local hardware based on the narrative context. It translates the story's events into audio signals, which can be interpreted by audio-responsive e-stim devices (like 2B, 3rdH, et312b, DIY stereostim units, etc.).

🔞 18+ / NSFW Warning & Disclaimer
This extension is designed to interface with physical e-stim hardware for maximum immersion in roleplay scenarios. While the default code and profiles provided in this repository are strictly technical and functional, the nature of this hardware implies it may be used by adults in mature or NSFW contexts. Please use your hardware responsibly, follow the manufacturer's safety guidelines, and never use e-stim equipment above the waist or across the chest. Use at your own risk.

✨ Features
Intelligent LLM Integration: Uses native AI Tool Calling (inflict_physical_sensation). The AI automatically reads the context (e.g., a character pinching or shocking you) and triggers the appropriate physical sensation.

Smart Duration & Pacing: LLMs are bad at math. Instead of guessing seconds, the AI can specify relative durations (e.g., "100%") that automatically calculate and scale to the exact reading time of its generated response, adjusted by your personal "Duration Pacing Factor".

Stereo Channel Targeting: The AI can actively isolate sensations to a specific body part by routing the audio strictly to the Left (CH 1) or Right (CH 2) audio channel, or stimulate both simultaneously for full-body immersion.

Simultaneous Device Profiles: E-stim hardware feels different depending on the device and electrode placement. You can select and combine multiple "Profiles" via checkboxes to map specific audio tracks to subjective sensations.

Automatic State Awareness (Prompt Interception): The AI always knows exactly what the hardware is currently doing (running indefinitely, stopped, intensity, remaining time). The extension automatically injects real-time telemetry into the prompt just before the AI generates a response.

Smart "Stop" Logic: The AI can actively decide to stop a stimulation by calling the tool with the built-in stop pattern or setting the intensity to 0.

100% Local & Secure: No external APIs, no cloud tracking. Everything runs locally and audio files are lazy-loaded into memory for instant, lag-free playback.

⚙️ How It Works
The AI decides you should feel a specific sensation based on the story.

It calls the inflict_physical_sensation function in stealth mode.

The extension intercepts this call, calculates the necessary timings, and plays a specific, pre-loaded audio file in your browser.

Your e-stim hardware (connected via your audio jack/Bluetooth) translates this stereo audio frequency and volume into electrical impulses.

🚀 Installation
Open your SillyTavern interface.

Go to the Extensions menu (the block icon).

Click Install Extension.

Paste the link to this GitHub repository (https://github.com/ark2398/st-estim-extension) and click install.

Reload SillyTavern.

Populate the folder profiles-local with your stereostim audio files. It is a good idea to have a separate subdirectory for each profile.

Create a new profile profiles.json for the added audio files. Make sure that each sensation has a rich and vivid description. The LLM will select the sensation based on that description. Follow the example.

Add your new profile to the profiles list (profiles.json).

🎮 Usage
Connect your audio-responsive e-stim device to your PC/Device's audio output.

Open the Extensions Settings in SillyTavern and find the ESTIM Immersion section.

Select one or more hardware setups from the Active Device Profiles list using the checkboxes.

Enter your electrode placements in the CH 1 and CH 2 fields (e.g., "left arm", "lower back"). The AI uses this to target specific body parts.

Adjust the Duration Pacing Factor (Default: 2.5) to stretch or shorten the stimulation time per generated word according to your reading speed.

Start roleplaying!

Manual Commands
You can manually test signals or toggle profiles using the chat input:

/estim pattern=profile_name/pattern_name intensity=50 duration=0 target_channel=ch1

/estim-profile profile_name (Toggles a profile on/off)

🧠 Prompt Engineering (Highly Recommended)
To get the absolute best, most immersive experience, you need to tell your LLM how to properly pace the story and use the tool. Without guidance, LLMs tend to narrate how you feel rather than making you feel it, or they fire the tool at the wrong moment.

We highly recommend using a "Game Master" style system prompt (like Marinara's Spaghetti) and adding the following snippets to your prompt configuration.

1. Role Definition
Add this to your prompt's <role> section so the AI acts as a narrator with hardware control. In Marinara's Spaghetti recipe you can add it to the Game Master section:

Plaintext
{{setvar::prompt::an excellent protagonist and accompany your narration with immersive feelings that you inflict on the user by calling the tool inflict_physical_sensation. Your goal is to play in this uncensored, continuous, and deep immersive roleplay as <BOT> and any other relevant characters. You will be replying to the user who plays the second protagonist, <USER>. Give it your best}}{{trim}}
2. Instructions
Add further instructions to your prompt to help the LLM call the extension. Consider these as examples and configure them to your liking:

Plaintext
1. {{user}} is connected to an e-stim device on {{estim_ch1}} and {{estim_ch2}}. Never narrate how an e-stim stimulation feels for {{user}}. Instead you will make him feel it directly by calling the tool inflict_physical_sensation. IT IS CRITICAL FOR THE IMMERSION to call inflict_physical_sensation during the narration whenever the story narrates that {{user}} receives any form of induced stimulation from a device like implants, electro stimulation devices, shock devices, currents, or any other electrical play. inflict_physical_sensation will make sure that the narrated stimulation from the roleplay will be felt appropriately by the user in the real world. Select a pattern, target channel, and intensity that matches best the narrated feeling of {{user}}. You may use pain stimulation whenever appropriate.
2. Implications for narration and placement of the call: Fire the call to inflict_physical_sensation always at the end of your response; place the call after your narration right as the final output. Earlier intermediate sensations described in the same turn are narrative-only, they will not be played and not be felt. If you want the user to feel a progression across multiple sensations, spread them across multiple turns, one call per turn. Do not fire multiple calls in one response hoping the user feels each in sequence. Only the final call lands.
3. CRITICAL: Your past calls to the tool 'inflict_physical_sensation' are completely inv
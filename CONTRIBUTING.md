# Contributing to the ESTIM Immersion Extension

First off, thank you for considering contributing to this project! 

Because every e-stim device (2B, 3rdH, et312b, DIY stereostim units) has different power curves, frequencies, and subjective feelings, **we rely on the community to build a comprehensive library of Device Profiles.**

Whether you are submitting a new device profile, adding audio files, or fixing a bug in the code, please read the guidelines below to ensure your contribution can be merged smoothly.

---

## 🛠️ How to Contribute a Device Profile

If you have dialed in the perfect audio tracks for your specific hardware, we would love to include it in the official `/profiles` directory!

### Step-by-Step
1. **Fork** this repository.
2. **Create a new `.json` file** inside the `/profiles` folder. Name it clearly (e.g., `stereostim_v2_balanced.json`).
3. **Format your JSON** based on the template below.
4. **Update the index:** Add your new filename to the array inside `/profiles/profiles.json`.
5. **Open a Pull Request (PR)** against the `main` branch of this repository.

### Profile Template & Macros
Because users place their electrodes on different body parts, **never hardcode body parts into your descriptions.** Instead, use the global macros `{{estim_ch1}}` and `{{estim_ch2}}`. The extension will automatically replace these with the user's UI settings.

**Example `my_device.json`:**
```json
{
  "display_name": "MyStereostim V1 (Intense)",
  "author": "YourUsername",
  "sensations": {
    "stroke": "A gentle, rhythmic tingling that feels like a light stroking across {{estim_ch1}}.",
    "shock": "A short, sharp pinch on {{estim_ch2}}, similar to a light needle prick.",
    "pulse": "A deep, throbbing sensation alternating between {{estim_ch1}} and {{estim_ch2}}.",
    "cramp": "An intense, continuous contraction of the muscles at {{estim_ch1}}."
  }
}
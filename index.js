
/**
 * ESTIM Local Extension for SillyTavern
 * 
 * ** THIS IS STILL WORK IN PROGRESS, EXPECT BUGS AND INCOMPLETE FEATURES **
 * 
 * This extension allows the AI to trigger electrostimulation (e-stim) signals on the 
 * user's hardware in sync with the narrative. The AI can call the "estim_mirror" function
 * tool with specific parameters to indicate when and how to stimulate the user based on 
 * the story context. The extension also provides a slash command for manual triggering 
 * and a button to stop all signals.
 * The available estim patterns and their corresponding audio files are defined in the 
 * "estims.json" configuration file. The extension ensures that only one signal plays at
 * a time, and it schedules the playback to occur right after the next message is fully
 * rendered, allowing for better synchronization with the story.
 * Note: This extension is designed for local use and does not require any external API 
 * or hardware integration. It simply plays audio files that represent different estim 
 * patterns, which can be used in conjunction with physical e-stim devices that respond 
 * to sound cues.
 * 
 * @author ark2398 ( https://github.com/ark2398 )
 * @version 1.7.0
 * @license AGPL-3.0-or-later
 */

import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from '../../../slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { isTrueBoolean } from '../../../utils.js';
export { MODULE_NAME };

const MODULE_NAME = 'estim';
const TEMPLATE_PATH = 'third-party/st-estim-extension';
const DEFAULT_DELAY_MS = 3000;
const DEBUG_MODE = true;   // Set to false to suppress non-critical console logs

// Configuration paths
const PATH_AUDIO_DEFAULT = './audio/';
const PATH_AUDIO_LOCAL = './audio-local/';
const PATH_PROFILES_DEFAULT = './profiles/';
const PATH_PROFILES_LOCAL = './profiles-local/';
const FILE_CONFIG_STIMS = 'estims.json';
const FILE_CONFIG_PROFILES = 'profiles.json';

const DEFAULT_CHANNEL_1_NAME = 'Genitals';
const DEFAULT_CHANNEL_2_NAME = 'Buttocks';

const ESTIM_MIN_AUDIOVOLUME = 0.3;
const ESTIM_MAX_PLEASURE_AUDIOVOLUME = 0.7;
const ESTIM_MAX_PAIN_AUDIOVOLUME = 1.0;

// Global State
let generationEndedHandler = null;

/**
 * Stores all state parameters of the currently playing audio
 */
let audioState = {
    playing: false,
    pattern: '',
    intensity: 0,
    duration: 0,
    looping: false,
    startTime: 0,
    audioContext: null,
    audioSource: null,
    audioGain: null,
    timerId: null
};


/**
 * Defines a singel estim sensation as it is read from file
 * @typedef {Object} EstimSensation
 * @property {boolean} [disabled] Optional parameter that can be set to true in the config to explicitly disable/remove a pattern from the available sensations. This is useful for users who want to remove certain patterns without deleting them from the config file.
 * @property {string} name The unique name of the sensation, used as an identifier in the AI tools (e.g. "tickle", "push", "cramp", "shock")
 * @property {string} description A subjective description of the sensation that is shown to the user and used in the AI tools. This should be written in a way that helps the user understand what kind of feeling to expect, and also helps the AI to choose the right pattern for a given narrative context. The description can include placeholders {{estim_ch1}} and {{estim_ch2}} which will be replaced with the AI-customizable channel names (default "Genitals" and "Buttocks") in the profile descriptions.
 * @property {string} file The relative path to the audio file that contains the stimulation pattern. This file should be a short audio clip (e.g. 1-10 seconds) that can be played to represent the sensation. The audio files are preloaded into memory for instant playback when triggered by the AI.
 * @property {boolean} canLoop Indicates whether this sensation can be looped indefinitely when a negative duration is set. If true, the audio will keep playing in a loop until a new command is issued. If false, the audio will only play once even if a negative duration is set. This allows for certain sensations to be designed as one-shots while others can be continuous.
 * @property {boolean} isPain Indicates whether this sensation is considered a pain sensation. This can be used by the AI to differentiate between pleasurable and painful patterns, and to choose appropriate patterns based on the narrative context and user preferences.
 * @property {number} duration The duration of the audio file in seconds. This is automatically calculated when the file is loaded and can be used by the AI to understand how long the sensation will last when triggered.
 * @property {Object} audioBuffer The decoded audio data that is preloaded into memory for instant playback. This is not defined in the config file but is created when the audio file is loaded. The audioBuffer is used by the Web Audio API to play the sound when the AI triggers the sensation.
 */

/**
 * Defines a singel profile as it is read from file
 * @typedef {Object} EstimProfile
 * @property {boolean} isActive Indicates whether this profile is currently active. This is not defined in the config file but is used in the global state to track which profiles are active and should be considered when generating the AI tool descriptions.
 * @property {string} name
 * @property {string} displayName
 * @property {string} author
 * @property {string} baseUrl The base URL for this profile, used to resolve relative paths for the audio files. This is automatically set when the profile is loaded and is not defined in the config file.
 * @property {EstimSensation[]} sensations
 */

/**
 * Stores the state of the currently active profiles, their descriptions for
 * the AI tools, and the list of available pattern names. This is updated 
 * whenever a profile is activated or deactivated, and is used to generate 
 * the context for the AI tools so they know which patterns are available
 * and how to describe them.
 */
let profilesState = {
    // @type {EstimProfile{}}
    profiles: {},             // All available profiles loaded from file, indexed by profile name
    patternDescriptions: '',  // The AI-facing descriptions of the patterns based on the active profile
    patternNames: []          // The list of pattern names available in the active profile
};


/**
 * Scheduled stimulation parameters that will be applied when
 * the next generation finishes. This allows the AI to set 
 * the desired stimulation parameters during generation, and 
 * then have them executed at the right moment after the 
 * message is rendered. While playing the sensation this object
 * will track the operational audio parameters.
 */
let scheduledEstim = {
    pending: false,
    pattern: '',
    intensity: 10,
    duration: 0
};


// ==== SETTINGS MANAGEMENT ====


// Define default settings
const defaultSettings = Object.freeze({
    lastActiveProfiles: [], // Remembers the last selected profiles
    channel1: DEFAULT_CHANNEL_1_NAME, // Name of channel 1 for AI tool context 
    channel2: DEFAULT_CHANNEL_2_NAME  // Name of channel 2 for AI tool context 
});


// Define a function to get or initialize settings
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();

    // Initialize settings if they don't exist
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    // Ensure all default keys exist (helpful after updates)
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = structuredClone(defaultSettings[key]);
        }
    }

    return extensionSettings[MODULE_NAME];
}


/**
 * Saves the current settings and refreshes the AI tools to reflect any changes. 
 * This should be called whenever a setting is changed that affects the behavior 
 * of the AI tools, such as switching profiles or changing channel names.
 */
async function updateSettings() {

    // Save profile
    const context = SillyTavern.getContext();
    if (typeof context.saveSettingsDebounced === 'function') {
        context.saveSettingsDebounced();
    }

    // Save profile to disk
    // In SillyTavern 1.0.6+ the saveSettingsDebounced function is exposed on the window object
    if (typeof window.saveSettingsDebounced === 'function') {
        window.saveSettingsDebounced();
    } else {
        // Fallback für exotische/ältere ST-Forks
        const context = SillyTavern.getContext();
        if (typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
        }
    }

    // Refresh the AI tools so the LLM gets the new sensation descriptions
    await registerAiFunctionTools();

    if (DEBUG_MODE) console.log(`ESTIM: Settings stored and tools updated`);
}


// ==== PROFILE LOADING ====


/**
 * Helper function to load profile JSON files from a specified directory 
 * and store them in the global state.
 * 
 * @param {*} folderPath 
 * @param {*} configFile 
 * @returns 
 */
async function loadProfileDirectory(folderPath, configFile) {
    const baseUrl = new URL(folderPath, import.meta.url).href;
    try {
        // Read the index file that lists all profile files in this directory
        const indexResp = await fetch(new URL(configFile, baseUrl).href);
        if (!indexResp.ok) return; // Silently skip if config (like user config) doesn't exist
        const profileFiles = await indexResp.json();

        // Iterate through each profile file, load it, and store the data in the global state
        for (const fileName of profileFiles) {
            try {
                if (DEBUG_MODE) {
                    console.log(`ESTIM: Loading profile from ${fileName}`);
                }

                const profileUrl = new URL(fileName, baseUrl).href;
                const profileResp = await fetch(profileUrl);
                if (!profileResp.ok) {
                    // Log a warning but continue loading other profiles if one profile file fails to load
                    console.warn(`ESTIM: Failed to load profile file ${fileName} (HTTP ${profileResp.status}). Skipping this profile.`);
                    continue;
                }

                // Parse the profile JSON data
                const profile = await profileResp.json();

                // Initialize base data that is not in the json
                profile.name = profile.name || fileName; // Use filename as fallback name if not specified in the profile
                profile.baseUrl = new URL('.', profileUrl).href; // Base URL for resolving relative paths
                profile.isActive = false;

                // Delete the key 'isInternal' in all sensations if it exists
                for (const sensation of profile.sensations || []) {
                    delete sensation.isInternal;
                }

                // Store profile with name or fileName as unique ID
                profilesState.profiles[profile.name] = profile;

                // Add stop pattern description to the profile's sensations for AI tool context
                profilesState.profiles[profile.name].sensations.push({
                    name: 'stop',
                    canLoop: false,
                    isPain: false,
                    isInternal: true, // This pattern is not defined in the config but is always available
                    description: 'Stop all signals immediately.'
                });

                if (DEBUG_MODE) {
                    console.log(`ESTIM: Profile "${profile.displayName}" loaded from ${fileName}`,
                        profilesState.profiles[profile.name]);
                }
            } catch (e) {
                console.error(`ESTIM: Failed to load profile file ${fileName}`, e);
            }
        }
    } catch (e) {
        console.warn('ESTIM: Error loading profiles in directory ${folderPath}.', e);
    }
}


/**
 * Loads all profile JSON files listed in profiles/index.json.
 * Each profile contains a displayName and mapping of patterns to sensations.
 */
async function loadProfiles() {
    profilesState.profiles = {};
    await loadProfileDirectory(PATH_PROFILES_DEFAULT, FILE_CONFIG_PROFILES);
    await loadProfileDirectory(PATH_PROFILES_LOCAL, FILE_CONFIG_PROFILES);

    await refreshActiveProfiles();
}



/**
 * Activates the profile and refreshes the AI tools.
 */
async function activateProfile(profileId, quiet = false) {

    // Validate profile ID and existence
    const profile = profilesState.profiles[profileId] || {};
    if (!profile) {
        console.error(`ESTIM: Profile ${profileId} not found.`);
        return false;
    }

    if (profile.isActive) {
        return true; // Already active, no need to refresh
    }

    // Calculate memory usage (Float32 PCM = 4 bytes per sample per channel)
    let totalMemoryBytes = 0;

    // Now read all sensations in the profile from the files and make
    // them available for the AI tools. This is necessary because the profile might 
    // have been just loaded and the sensations are not yet processed, or 
    // because the user activated a profile that was previously deactivated 
    // and we need to make sure all its sensations are ready to be used.
    for (const sensation of profile.sensations || []) {

        // Check if the sensation already has an audioBuffer, which means it is already loaded 
        // and ready to use.
        if (sensation.audioBuffer) {
            continue;
        }

        // Make sure a name is specified
        sensation.name = sensation.name || sensation.file || 'unknown';

        // Check if user disabled/deleted this pattern explicitly
        if (sensation.disabled === true) {
            if (DEBUG_MODE) console.log(`ESTIM: Pattern "${sensation.name}" explicitly removed by config.`);
            continue;
        }

        // Silently ignore internal patterns that are not meant to be defined in the config file but 
        // are added automatically (like "stop") and should not be loaded from files. This allows us
        // to add built-in patterns in the code without worrying about them being defined in the config,
        // and also to have a clear way for users to define patterns that are only used internally 
        // and not exposed to the AI tools.
        if (sensation.isInternal === true) {
            continue;
        }

        // Validate that the sensation has a file. If not, log a warning and skip it.
        if (!sensation.file) {
            console.warn(`ESTIM: Pattern "${sensation.name}" has no audio file specified.`);
            continue;
        }

        try {
            // Fetch and decode audio file relative to its config folder
            const audioUrl = new URL(sensation.file, profile.baseUrl).href;
            const audioResp = await fetch(audioUrl);
            if (!audioResp.ok) throw new Error(`HTTP ${audioResp.status}`);

            const arrayBuffer = await audioResp.arrayBuffer();

            // Store the decoded audio buffer in the sensation object for later use
            sensation.audioBuffer = await audioState.audioContext.decodeAudioData(arrayBuffer);
            sensation.duration = sensation.audioBuffer.duration;

            // Calculate memory usage for this sensation and add it to the total.
            //  This is useful for debugging and optimization, especially if users add their own
            //  audio files which might be large.
            if (sensation.audioBuffer) {
                totalMemoryBytes += sensation.audioBuffer.length * sensation.audioBuffer.numberOfChannels * 4;
            }

            // Defaults
            sensation.canLoop = sensation.canLoop || false;
            sensation.isPain = sensation.isPain || false;
            sensation.description = sensation.description || '';

            if (DEBUG_MODE) console.log(`ESTIM: Loaded pattern "${sensation.name}" from ${sensation.file}`);

        } catch (e) {
            console.error(`ESTIM: Failed to load ${sensation.file}`, e);
        }
    }

    if (DEBUG_MODE) {
        const totalMB = (totalMemoryBytes / (1024 * 1024)).toFixed(2);
        console.log(`ESTIM: 🎵 Loaded estim patterns — Total preloaded memory: ${totalMB} MB`);
    }

    // Mark this profile as active
    profile.isActive = true;

    // Persist it in the settings so that it can be remembered for the next session. 
    const settings = getSettings();
    if (!settings.lastActiveProfiles.includes(profileId)) {
        settings.lastActiveProfiles.push(profileId);
    }

    // Update all data
    refreshActiveProfiles();

    if (DEBUG_MODE) console.log(`ESTIM: Activated profile "${profilesState.profiles[profileId].displayName}"`);
    return true;
}


/**
 * Disables the profile and refreshes the AI tools.
 */
async function deactivateProfile(profileId, quiet = false) {

    // Validate profile ID and existence
    const profile = profilesState.profiles[profileId] || {};
    if (!profile) {
        console.error(`ESTIM: Profile ${profileId} not found.`);
        return false;
    }

    if (!profile.isActive) {
        return true; // Already deactivated, no need to refresh
    }

    // Turn profile off
    profile.isActive = false;

    // TODO Persist it in the settings so that it can be remembered for the next session. 
    const settings = getSettings();
    settings.lastActiveProfiles = settings.lastActiveProfiles.filter(id => id !== profileId);

    // Update all data
    refreshActiveProfiles();

    if (DEBUG_MODE) console.log(`ESTIM: Deactivated profile "${profilesState.profiles[profileId].displayName}"`);
    return true;
}



/**
 * Refreshes the AI tools based on the active profiles
 */
async function refreshActiveProfiles() {

    // Get current channel names with fallback to defaults if not set. These will be used to 
    // replace the placeholders in the profile descriptions.
    const settings = getSettings();
    const ch1_text = settings.channel1 || DEFAULT_CHANNEL_1_NAME;
    const ch2_text = settings.channel2 || DEFAULT_CHANNEL_2_NAME;

    // This will be filled with descriptions
    profilesState.patternNames = [];
    profilesState.patternDescriptions = '';

    // Iterate over all profiles and check if they are active. If they are, add their patterns and descriptions
    // to the list of available patterns for the AI tool.
    for (const [profileId, profile] of Object.entries(profilesState.profiles || {})) {

        // If the profile is not active, skip it. This allows users to have multiple profiles in their config
        //  but only activate the ones they want to use, without having to delete or comment out the others.
        if (!profile.isActive) {
            continue;
        }

        // Iterate over all sensations in the profile and create the description string for each sensation.
        // This will be used in the AI tool to help the AI understand what each sensation does and how it feels.
        for (const sensation of profile.sensations || []) {

            // Replace {{CH1}} and {{CH2}} (Case-Insensitive)
            let parsedDesc = sensation.description
                .replace(/\{\{estim_ch1\}\}/gi, ch1_text)
                .replace(/\{\{estim_ch2\}\}/gi, ch2_text);

            // Add some specifiers at the end
            if (sensation?.duration > 0) {
                if (sensation?.canLoop) {
                    parsedDesc = `${parsedDesc} (cycle duration: ${sensation.duration.toFixed(1)} s, can loop indefinitely)`;
                }
                else {
                    parsedDesc = `${parsedDesc} (maximum duration: ${sensation.duration.toFixed(1)} s)`;
                }
            }

            // Add pain specifier at the beginning if it is a pain sensation. This helps the AI 
            // to differentiate between pleasure and pain sensations, especially when they can 
            // be made painful by increasing the intensity.
            if (sensation?.isPain) {
                parsedDesc = `Pain signal. ${parsedDesc}`;
            }

            // Store the processed string
            const uniquePatternName = `${profile.name}/${sensation.name}`;
            profilesState.patternNames.push(uniquePatternName);
            profilesState.patternDescriptions += `  - "${uniquePatternName}": ${parsedDesc}\n`;
        }

        if (DEBUG_MODE) {
            console.log(`ESTIM: Active profile ${profile.displayName} with patterns: ${profilesState.patternNames.join(', ')}`);
        }
    }

    // Update UI Dropdown if it exists
    //$('#estim_profile_select').val(profileId);

    // Stores the settings and updates the strings
    await updateSettings();
    return true;
}


// ==== AUDIO CORE ====


/**
 * Plays the audio signal corresponding to the given estim pattern, intensity and duration. This is called after 
 * the next message is fully rendered, allowing the user to receive the stimulation at the right moment in the narrative.
 * 
 * @param {string} pattern The name of the estim pattern to use in the format "profileId/patternName" (e.g. "karla/tickle", "karla/push", "karla/cramp", "karla/shock")
 * @param {string|number} intensity The intensity of the signal, from "1" to "100" for pleasurable intensities and "101" to "200" for pain intensities. Default is "10". "0" stops the signal immediately.
 * @param {string|number} duration The duration of the signal in seconds. Default is "0" which plays the file once. -1 means looping
 * @param {boolean} quiet Suppress chat output
 * @returns 
 */
async function playEstimSignal(pattern, intensity = 10, duration = 0, quiet = false) {

    // The sensation to play
    let sensation = {};

    // Stop stimulation? (we do not care if the other parameters are correct, because "stop" has top priority)
    // If intensity is 0, we interpret this also as stop without starting a new one.
    if (intensity === 0 || pattern.toLowerCase() === 'stop') {
        stopAllEstimSignals();
        return true;
    }

    // 'pattern' must be in the format "profileId/patternName", so we split it to get the 
    // profile and pattern name. This allows us to have multiple profiles with patterns 
    // of the same name without conflicts.
    const [profileId, patternName] = pattern.split('/');

    // Check again to stop the stimulation
    if (patternName?.toLowerCase() === 'stop') {
        stopAllEstimSignals();
        return true;
    }

    // Retrieve profile 
    const profile = profilesState.profiles[profileId];
    if (!profile) {
        console.error(`ESTIM: Profile "${profileId}" not found for pattern "${pattern}".`);
        if (!quiet) {
            SillyTavern.getContext().sendSystemMessage('generic', `Unknown profile "${profileId}" for pattern "${pattern}"`, { isSmallSys: true });
        }
        return false;
    }

    // Find the sensation by finding the first sensation that has the pattern name matching the requested one.
    sensation = profile.sensations?.find(s => s.name === patternName);
    if (!sensation) {
        console.error(`ESTIM: Pattern "${patternName}" not found in profile "${profileId}".`);
        if (!quiet) {
            SillyTavern.getContext().sendSystemMessage('generic', `Unknown pattern "${patternName}" in profile "${profileId}"`, { isSmallSys: true });
        }
        return false;
    }

    // Ensure the AudioContext is resumed in response to a user gesture, if it is currently suspended. 
    // This is necessary because many browsers require a user interaction before allowing audio playback.
    await ensureAudioContext();
    if (!audioState.audioContext) {
        return false; // Failsafe if hardware unsupported
    }

    // Stop any previous signal with a tiny fade-out first
    stopAllEstimSignals(10, true);

    // Make sure that the limits are correctly set. Assume that max pain is absolutely, so max pleasure must be below that.
    // And minimum must be below max pleasure
    const maxPain = Math.max(0, ESTIM_MAX_PAIN_AUDIOVOLUME);
    const maxPleasure = Math.max(0, Math.min(ESTIM_MAX_PLEASURE_AUDIOVOLUME, maxPain - 0.01));
    const minVol = Math.max(0, Math.min(ESTIM_MIN_AUDIOVOLUME, maxPleasure - 0.01));

    // Calculate target volume 
    intensity = Math.max(0, Math.min(200, parseInt(intensity) || 10));
    let targetVolume = 0;
    if (intensity > 0) {
        if (intensity <= 100) {
            targetVolume = minVol + ((intensity - 1) / 99) * (maxPleasure - minVol);
        } else {
            targetVolume = maxPleasure + ((intensity - 101) / 99) * (maxPain - maxPleasure);
        }
    }

    const now = audioState.audioContext.currentTime;
    const fadeInTime = 0.012;   // 12 ms fade-in — this kills the plop

    // Create nodes
    audioState.audioSource = audioState.audioContext.createBufferSource();
    audioState.audioSource.buffer = sensation.audioBuffer;

    // Create listener to clean up when the playback ends
    audioState.audioSource.onended = () => {
        if (DEBUG_MODE) console.log(`ESTIM: Stop event called`);
        audioState.playing = false;

        // Terminate running audio termination timer if there still exists one
        if (audioState.timerId) {
            clearTimeout(audioState.timerId);
            audioState.timerId = null;
        }
    };

    audioState.audioGain = audioState.audioContext.createGain();
    audioState.audioGain.gain.setValueAtTime(0.001, now);  // start almost silent

    audioState.audioSource.connect(audioState.audioGain);
    audioState.audioGain.connect(audioState.audioContext.destination);

    // Start playback
    audioState.audioSource.start(now);

    // Smooth exponential ramp up (sounds natural)
    audioState.audioGain.gain.exponentialRampToValueAtTime(targetVolume, now + fadeInTime);

    // Set audio cancel timer if a specific duration was set
    if (duration > 0) {
        // Set looping to repeat the audio in case the duration
        // is set longer than the duration of the file. 
        audioState.audioSource.loop = true;
        audioState.looping = false;

        // Start timer
        audioState.timerId = setTimeout(() => {
            audioState.timerId = null; // Remove reference to this timeout
            stopAllEstimSignals(15);
        }, duration * 1000);
    }
    if (duration < 0) {
        // A negative value indicates that the playback shall continue
        // until a new command is issued. Only do this if it is allowed
        if (sensation.canLoop) {
            // Set looping 
            audioState.audioSource.loop = true;
            audioState.looping = true;
        }
        else {
            // No looping allowed. Set to single playback
            duration = 0;
            console.warn(`ESTIM: Continuous playback of non-loopable sensation ${pattern} prevented`);
        }
    }
    if (duration === 0) {
        // Play the file exactly one time and then stops
        audioState.audioSource.loop = false;
        audioState.looping = false;

        // TODO Register a listener when the audio playback ended
    }

    // Remember everything
    audioState.startTime = now;
    audioState.playing = true;
    audioState.pattern = pattern;
    audioState.intensity = intensity;
    audioState.duration = duration;

    // Console + system message
    if (DEBUG_MODE) console.log(`ESTIM: 🎵 Playing ${sensation.file} | intensity ${intensity}% | fade-in 12ms`);
    if (!quiet) {
        const context = SillyTavern.getContext();
        context.sendSystemMessage('generic', `Estim pattern "${pattern}" with intensity ${intensity}%`, { isSmallSys: true });
    }

    return true;
}


/**
 * Stops all currently active estim signals with a quick fade-out to avoid audio artifacts. 
 * This is called before starting a new signal to ensure that only one signal plays at a 
 * time, and also when the user clicks the "Stop" button.
 * 
 * @param {number} fadeOutMs The duration of the fade-out in milliseconds. Default is 15ms for a quick but smooth fade-out.
 * @param {boolean} quiet Suppress chat output
 */
function stopAllEstimSignals(fadeOutMs = 15, quiet = false) {

    // Stop playing audio
    try {
        const now = audioState.audioContext.currentTime;
        if (audioState.audioGain) {
            audioState.audioGain.gain.cancelScheduledValues(now);
            audioState.audioGain.gain.exponentialRampToValueAtTime(0.001, now + fadeOutMs / 1000);
            audioState.audioGain = null;
        }
        if (audioState.audioSource) {
            audioState.audioSource.stop(now + fadeOutMs / 1000 + 0.01);
            audioState.audioSource = null;
        }
    } catch (e) { }

    // Terminate running audio termination timer if there still exists one
    if (audioState.timerId) {
        clearTimeout(audioState.timerId);
        audioState.timerId = null;
    }

    // Remember that we stopped
    audioState.playing = false;

    if (DEBUG_MODE) console.log(`ESTIM: All estim signals stopped (fade-out ${fadeOutMs}ms)`);
    if (!quiet) {
        SillyTavern.getContext().sendSystemMessage('generic', 'Estim stimulation stopped.', { isSmallSys: true });
    }
}


/**
 * Initializes the Web AudioContext for audio playback.
 * @returns {Promise<AudioContext|null>} A promise resolving to the initialized AudioContext or null if failed.
 */
async function initAudioContext() {
    if (audioState.audioContext) return audioState.audioContext;

    try {
        audioState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (DEBUG_MODE) console.log('ESTIM: Web AudioContext initialized');
        return audioState.audioContext;
    } catch (err) {
        console.error('ESTIM: Failed to create AudioContext. Audio is not supported in this environment.', err);
        return null;
    }
}


/**
 * Ensures the AudioContext is resumed in response to a user gesture, 
 * if it is currently suspended. This is necessary because many browsers 
 * require a user interaction before allowing audio playback.
 */
async function ensureAudioContext() {
    if (audioState.audioContext?.state === 'suspended') {
        await audioState.audioContext.resume();
        if (DEBUG_MODE) console.log('ESTIM: AudioContext resumed via user gesture');
    }
}


/**
 * Automatically attempts to unlock the AudioContext on the first user interaction.
 * Browsers block audio playback until the user clicks or presses a key on the page.
 */
function setupAutoAudioUnlock() {
    const unlockHandler = async () => {
        await ensureAudioContext();

        if (DEBUG_MODE) console.log('ESTIM: 🎵 AudioContext automatically unlocked via user interaction.');

        // Remove the event listeners immediately after the first interaction
        // so we don't waste performance on subsequent clicks/keypresses.
        document.removeEventListener('click', unlockHandler);
        document.removeEventListener('keydown', unlockHandler);
        document.removeEventListener('touchstart', unlockHandler);
    };

    // Listen for any standard interaction on the entire document
    document.addEventListener('click', unlockHandler);
    document.addEventListener('keydown', unlockHandler);
    document.addEventListener('touchstart', unlockHandler);
}


// ==== AI TOOLS & COMMANDS ====


/**
 * Register function tools for this extension. This allows the AI to call these 
 * functions during narration.
 * * @returns 
 */
async function registerAiFunctionTools() {
    try {
        const {
            registerFunctionTool,
            unregisterFunctionTool,
            isToolCallingSupported,
            eventSource,
            event_types
        } = SillyTavern.getContext();

        // Unregister first to avoid duplicates during development
        unregisterFunctionTool('inflict_physical_sensation');
        //unregisterFunctionTool('estim_set_profile');

        if (!isToolCallingSupported()) {
            console.warn('ESTIM: Function calling is not supported by your current API.');
            return;
        }

        if (profilesState.patternNames.length === 0) {
            console.warn('ESTIM: No patterns loaded. Skipping AI tool registration.');
            return;
        }

        const estimSchema = {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    enum: profilesState.patternNames,
                    description: 'The sensation pattern to inflict on the user. If a sensation is painful due to its shape, ' +
                        'it is also indicated in the following description. Current available sensations:\n' +
                        profilesState.patternDescriptions
                },
                intensity: {
                    type: 'integer',
                    description: 'Intensity 1-100 (pleasure intensity), 101-200 (pain intensity). Every sensation ' +
                        'can be made painful by increasing its intensity to pain intensity. This means that normal ' +
                        'pleasure sensations will become pain sensations at intensities greater 100, whereas ' +
                        'pain sensations will always be painfull regardless of a certain intensity threshold. ' +
                        'To unlock painful intensities, "is_pain_intensity" must be set to true as a safety measure. ' +
                        'Default is 10 (low intensity). The intensity is a multiplier to the intensity indication ' +
                        'in the description.\n' +
                        'Baseline guidance for matching narration: Select the intensity according to the required ' +
                        'intensity to match the current tension in the story. Increase the intensity slowly over ' +
                        'multiple turns. Never rush to the highest intensity right from the start. Build an escalation ' +
                        'over multiple turns.',
                },
                is_pain_intensity: {
                    type: 'boolean',
                    description: 'Whether pain intensity (101-200) shall be available. Default is false.',
                },
                duration: {
                    type: 'integer',
                    description: 'Duration of the inflicted sensation in seconds. Default is 0, which plays ' +
                        'the pattern for its native length as indicated in the pattern description. A negative ' +
                        'value loops the pattern continuously until changed or stopped by another call.\n' +
                        'Baseline guidance for matching narration: When the sensation is meant to accompany ' +
                        'the narration text of the current response, set duration to approximately match ' +
                        'the reader\'s time-on-page. Estimate at ~3 words per second (180 wpm) and multiply ' +
                        'by 1.5 to allow for pacing and savoring. Round to the nearest whole second. ' +
                        'Examples: 30 words ≈ 12 s, 60 words ≈ 24 s, 90 words ≈ 36 s, 150 words ≈ 60 s. ' +
                        'For looped sensations try to select a multiple of the cycle time.\n' +
                        'Exceptions:\n' +
                        '- For sensations intended to persist across multiple turns or scenes ' +
                        '(e.g. background stimulation), use a negative value (continuous loop).\n' +
                        '- For brief punctuating hits within longer narration (a single zap, a momentary ' +
                        'jolt), use a short fixed duration of 2–5 s regardless of word count.\n' +
                        'For sensations whose narrated arc is shorter than the pattern\'s native length ' +
                        '(e.g., a quick warning), cap the duration at the narrated beat\'s reading time ' +
                        'rather than letting it run full.',
                },
                who: {
                    type: 'string',
                    description: 'The name of the character to inflict the sensation on.',
                }
            },
            required: ['pattern', 'who'],
        };

        registerFunctionTool({
            name: 'inflict_physical_sensation',
            displayName: 'Inflict Physical Sensation',
            description: 'Use this tool to inflict a real physical sensation on the user\'s body. ' +
                'Call this seamlessly while narrating. Use the descriptions in the "pattern" parameter to ' +
                'select the physical sensation that matches the narraded story best. Select intensity and ' +
                'accoding to the rules in the parameter descriptions.',
            //'IMPORTANT: You must generate the story text and call the tool in the same response. Do ' +
            //'not stop generating text after calling this tool!',
            parameters: estimSchema,
            stealth: false,
            action: async (args) => {

                // Recognize special "stop" command: If intensity is 0 or pattern name is "stop", 
                // we interpret this as a command to stop the signal immediately without starting a new one. 
                if (args.intensity === 0 || args.pattern.toLowerCase() === 'stop') {
                    stopAllEstimSignals();
                    return 'Stopped all e-stim signals.';
                }

                if (!args?.pattern) {
                    return `Missing required parameter "pattern". Please specify which estim pattern ` +
                        `to play based on the narrative context. Available patterns:\n${profilesState.patternDescriptions}`;
                }
                if (!args?.who) {
                    return `Missing required parameter "who". Please specify the character to stimulate. ` +
                        `It must be the current player character.`;
                }

                // Check if the estim shall be applied to the current user (the one that is {{user}}).
                // Refuse to play if the "who" parameter specifies a different character. 
                // This is important to avoid sending unintended signals to the user.
                const user = SillyTavern.getContext().name1; // Get the current user's name from the context
                if (args.who.toLowerCase() !== user.toLowerCase()) {
                    console.warn(`ESTIM: Received request to stimulate "${args.who}", but only "${user}" is supported. No signal will be sent.`);
                    return `Cannot stimulate "${args.who}". Only "${user}" is supported.`;
                }

                // Limit intensity to 1-200 (1-100 is pleasurable, 101-200 is painful if "is_pain_intensity" is true)
                let intensityValue = parseInt(args.intensity) || 10;
                intensityValue = Math.max(0, Math.min(200, intensityValue));  // Clamp to 0 to 200
                const pain_enabled = isTrueBoolean(String(args.is_pain_intensity));
                if (!pain_enabled) { // Not pain intensity, clamp to 0 to 100
                    intensityValue = Math.min(100, intensityValue);
                }

                // Limit intensity to 1-200 (1-100 is pleasurable, 101-200 is painful if "is_pain_intensity" is true)
                let durationValue = parseInt(args.duration) || 0;
                durationValue = Math.max(-1, durationValue);  // Clamp to (-1) to infinity

                // Store the parameters for the next signal
                scheduledEstim.pattern = args.pattern;
                scheduledEstim.intensity = intensityValue;
                scheduledEstim.duration = durationValue;
                scheduledEstim.pending = true;

                // Wait exactly 1 second to allow SillyTaverns automatic toastr to settle in the UI
                await new Promise(resolve => setTimeout(resolve, 1000));

                return `Stimulation "${scheduledEstim.pattern}" inflicted. ` +
                    `SYSTEM INSTRUCTION: You MUST now continue generating the narrative ` +
                    `response for the user. Do not stop writing!`;
                //return `Stimulation "${scheduledEstim.pattern}" inflicted.`;
            },
            formatMessage: () => 'Estim tool called successfully.',
            // Wir formatieren den Tool-Aufruf für den Chat wunderschön und minimalistisch:
            //formatMessage: (args) => {
            //    return `<div style="opacity: 0.6; font-size: 0.85em; font-style: italic; margin-top: 5px;">
            //                ⚡ System: Applied "${args.pattern}" at ${args.intensity || 10}%.
            //            </div>`;
            //},
        });

        /*
        registerFunctionTool({
            name: 'estim_set_profile',
            displayName: 'Switch Device Profile',
            description: 'Changes the active estim device configuration. Use this if the story justifies changing how stimuli are felt (e.g., moving electrodes).',
            parameters: {
                type: 'object',
                properties: {
                    profile_name: {
                        type: 'string',
                        enum: Object.keys(estimProfiles),
                        description: 'Internal filename of the profile.'
                    }
                },
                required: ['profile_name']
            },
            action: async (args) => {
                const success = await switchProfile(args.profile_name);
                return success ? `Switched to profile ${estimProfiles[args.profile_name].displayName}` : "Profile not found.";
            }
        }); */

        // Removes the event listener if already registered
        if (generationEndedHandler) {
            eventSource.removeListener(event_types.GENERATION_ENDED, generationEndedHandler);
            generationEndedHandler = null;
        }

        // Register a listener that will fire when the FULL AI generation is finished
        // (including thinking mode / multi-message responses). This guarantees the
        // estim signal only plays after ALL messages are visible on screen.
        generationEndedHandler = () => {
            setTimeout(async () => {
                try {
                    // Check if estimPattern is set, otherwise we are already finished
                    if (!scheduledEstim.pending) {
                        return;
                    }

                    scheduledEstim.pending = false;
                    await playEstimSignal(scheduledEstim.pattern, scheduledEstim.intensity, scheduledEstim.duration);
                } catch (err) {
                    console.error('ESTIM: Could not play audio:', err);
                }
            }, DEFAULT_DELAY_MS);
        };
        eventSource.on(event_types.GENERATION_ENDED, generationEndedHandler);

        if (DEBUG_MODE) console.info('ESTIM: function registered successfully');
    } catch (e) {
        console.error('ESTIM: Tool error', e);
    }
}


/**
 * Register slash commands for this extension. This allows the user to manually 
 * trigger actions from the chat input.
 */
async function registerCommand() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'estim',
        callback: async (args, value) => {
            const quiet = isTrueBoolean(String(args.quiet));
            if (DEBUG_MODE) console.log('ESTIM command called with arguments:', args, 'and unnamed value:', value);
            await playEstimSignal(args.pattern, args.intensity, args.duration, quiet);
            return `ESTIM stimulation triggered: pattern=${args.pattern}, intensity=${args.intensity}, duration=${args.duration}s.`;
        },
        helpString: 'Start an estim stimulation with the specified pattern, intensity and duration.',
        returns: 'Status about the stimulation request.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'Do not display the result in chat',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: String(false),
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'pattern',
                description: 'The pattern to play',
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: String(''),
                enumProvider: () => profilesState.patternNames,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'intensity',
                description: 'The intensity of the stimulation from 1 to 100. Default is 10.',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: String('10'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'duration',
                description: 'The duration of the stimulation in seconds. 0 plays the ' +
                    'sensation exactly once, -1 loops the sensation.',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: String('0'),
            }),
        ],
        unnamedArgumentList: [],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'estim-profile',
        callback: async (args) => {
            const profileId = args.unnamed;
            const profile = profilesState.profiles[profileId];
            if (!profile) return `Profile "${profileId}" not found.`;

            if (profile.isActive) {
                await deactivateProfile(profileId);
                return `ESTIM: Deactivated profile "${profileId}"`;
            } else {
                await activateProfile(profileId);
                return `ESTIM: Activated profile "${profileId}"`;
            }
        },
        helpString: 'Toggle the active state of an estim profile by filename.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Profile filename',
                isRequired: true,
                // Bonus: Autocomplete für Profilnamen im Chat!
                enumProvider: () => Object.keys(profilesState.profiles)
            })
        ],
    }));
}


/**
 * Register UI elements for this extension. This adds buttons, settings panels, 
 * or other interactive elements to the SillyTavern interface.
 */
async function registerUiElements() {

    // Add settings panel
    const settingsHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    const getSettingsContainer = () => $(document.getElementById('estim_container') ?? document.getElementById('extensions_settings2'));
    getSettingsContainer().append(settingsHtml);

    // --- Checkbox-Liste befüllen ---
    const $profileList = $('#estim_profile_list');
    $profileList.empty(); // Entfernt den "Loading profiles..." Text

    const settings = getSettings();
    const activeIds = settings.lastActiveProfiles || [];

    // Generiere für jedes Profil eine Checkbox
    Object.entries(profilesState.profiles).forEach(([id, data]) => {
        const isChecked = activeIds.includes(id) ? 'checked' : '';
        const displayName = data.displayName || data.name;
        const author = data.author ? ` <span style="opacity: 0.5; font-size: 0.85em;">(by ${data.author})</span>` : '';

        const checkboxHtml = `
            <div style="margin-bottom: 6px;">
                <label style="display: flex; align-items: center; cursor: pointer; user-select: none;">
                    <input type="checkbox" class="estim-profile-checkbox" value="${id}" ${isChecked} style="margin-right: 8px; cursor: pointer;">
                    <span>${displayName}${author}</span>
                </label>
            </div>
        `;
        $profileList.append(checkboxHtml);
    });

    // Event-Listener für Klicks auf die Checkboxen
    $profileList.on('change', '.estim-profile-checkbox', async function () {
        const profileId = $(this).val();
        const isSelected = $(this).is(':checked');

        if (isSelected) {
            await activateProfile(profileId, false);
        } else {
            await deactivateProfile(profileId, false);
        }
    });

    // Map channel input names to settings and update AI tools on change
    $('#estim_ch1_input').val(settings.channel1).on('change', async function () {
        settings.channel1 = $(this).val();
        await updateSettings(); // Persist settings and update AI tools
    });
    $('#estim_ch2_input').val(settings.channel2).on('change', async function () {
        settings.channel2 = $(this).val();
        await updateSettings(); // Persist settings and update AI tools
    });

    // Add the button to the extensions menu
    const buttonHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'button');
    const getWandContainer = () => $(document.getElementById('estim_wand_container') ?? document.getElementById('extensionsMenu'));
    getWandContainer().append(buttonHtml);

    // Add stop button action
    $('#estim_stop').on('click', (e) => {
        e.preventDefault();
        stopAllEstimSignals();
    });

    // Register global macros for channel names so they can be used in the profile descriptions.
    const { macros } = SillyTavern.getContext();
    if (macros && typeof macros.register === 'function') {

        macros.register('estim_ch1', {
            description: 'Returns the name of ESTIM Channel 1',
            handler: () => getSettings().channel1 || DEFAULT_CHANNEL_1_NAME
        });

        macros.register('estim_ch2', {
            description: 'Returns the name of ESTIM Channel 2',
            handler: () => getSettings().channel2 || DEFAULT_CHANNEL_2_NAME
        });

        // Pattern-Makro: Generiert eine formatierte Liste aller Patterns des aktuellen Profils
        macros.register('estim_patterns', {
            description: 'Returns a list of all available ESTIM patterns for the active profile',
            handler: () => profilesState.patternDescriptions
        });

        // Pattern-Makro: Generiert eine formatierte Liste aller Patterns des aktuellen Profils
        macros.register('estim_state', {
            description: 'Returns the E-stim state at start of a turn. Inject into prompt.',
            handler: () => {
                if (!audioState.playing) {
                    return "no sensation inflicted";
                }

                // Calculate elapsed time
                const elapsedTime = audioState.audioContext.currentTime - audioState.startTime;

                let state = `pattern: \"${audioState.pattern}\", intensity: ${audioState.intensity}, ` +
                    `looping: ${audioState.looping}, elapsed_time: ${elapsedTime.toFixed(1)} s`;

                if (!audioState.looping) {
                    state = `${state}, total_duration: ${audioState.duration} s`
                }

                return state;
            }
        });

        if (DEBUG_MODE) console.log('ESTIM: Custom macros {{estim_ch1}}, {{estim_ch2}} and {{estim_patterns}} registered globally.');
    }
}


/**
 * This function is called by SillyTavern when the extension is activated. 
 * It registers all the necessary components of the extension, such as function tools, 
 * slash commands, and UI elements.
 */
export async function onActivate() {
    await initAudioContext();
    await loadProfiles();
    setupAutoAudioUnlock();

    // Determine initial profile(s) to activate based on settings
    const settings = getSettings();
    const available = Object.keys(profilesState.profiles);
    if (!Array.isArray(settings.lastActiveProfiles)) {
        settings.lastActiveProfiles = [];
    }

    // Fallback: If no last active profiles are set in the settings, activate the first available profile by default
    //if (settings.lastActiveProfiles.length === 0 && available.length > 0) {
    //    settings.lastActiveProfiles = [available[0]];
    //}

    // Activate all profiles that are listed in the settings
    for (const id of settings.lastActiveProfiles) {
        if (available.includes(id)) {
            await activateProfile(id, true);
        }
    }

    await registerUiElements();
    await registerCommand();
}


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
 * @version 2.0.3
 * @license AGPL-3.0-or-later
 */

import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from '../../../slash-commands/SlashCommandEnumValue.js';
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

const ESTIM_MIN_AUDIOVOLUME = 0.2;
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
    timerId: null,
    targetChannel: 'both' // 'both' (default), 'ch1', or 'ch2'
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
 * @property {boolean} isSystem Indicates whether this profile is a system profile.
 * @property {string} name
 * @property {string} displayName
 * @property {string} author
 * @property {string} description A general description of all sensations in this profile.
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
    patternNames: [],          // The list of pattern names available in the active profile
    profileDescriptions: '' // The AI-facing descriptions of the profiles based on the active profile
};


/**
 * Scheduled stimulation parameters that will be applied when
 * the next generation finishes. This allows the AI to set
 * the desired stimulation parameters during generation, and
 * then have them executed at the right moment after the
 * message is rendered. While playing the sensation this object
 * will track the operational audio parameters.
 */
let scheduledNextAction = {
    pending: false,
    pattern: '',
    intensity: 10,
    durationRaw: '0', // The raw duration value as set by the AI, which can be a number in seconds or a percentage string (e.g. "100%")
    finalDurationSeconds: 0, // The final duration in seconds that is calculated based on the raw duration and the audio file length. This is the value that is actually used to schedule the stop command.
    targetChannel: 'both',
    remoteControlConfig: null // The restricted remote control configuration as specified by the AI in the "restricted_remote_control" parameter.
};

/**
 * The restricted remote is a UX element that allows the user to
 * interact with the played sensations in real-time and in a way
 * the llm allows it (e.g. stop the sensation, adjust intensity,
 * or change the calibration). That's why it is called "restricted remote",
 * because the user can only do what the AI allows them to do,
 * which adds an interesting dynamic to the interaction. The
 * state of the remote is stored in this object.
 */
let restrRemoteState = {
    isOpen: false,
    telemetryQueue: [],
    calibrationPattern: null,
    remoteControlConfig: null
};


// ==== SETTINGS MANAGEMENT ====


// Define default settings
const defaultSettings = Object.freeze({
    lastActiveProfiles: [], // Remembers the last selected profiles
    channel1: DEFAULT_CHANNEL_1_NAME, // Name of channel 1 for AI tool context
    channel2: DEFAULT_CHANNEL_2_NAME,  // Name of channel 2 for AI tool context
    durationStretchFactor: 1.5,        // Pacing factor for smart durations
    customCalibrations: {},            // Personal calibrations for each
    minCalibration: null,              // Minimum calibration value for the audio volume
    maxPleasureCalibration: null,      // Maximum calibration value for pleasure sensations
    maxPainCalibration: null,          // Maximum calibration value for pain sensations
    blindfoldModes: false,             // Whether to hide the toast notifications when a sensation is played.
    simulationOnly: false              // Whether to only simulate the sensations without actually outputting them.
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

                // Delete the key 'isSystem' if it exists
                delete profile.isSystem;

                // Store profile with name or fileName as unique ID
                profilesState.profiles[profile.name] = profile;

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

    // Clear the set and initialize the system profile with the "stop" sensation, which is
    // always available and does not need to be defined in the config file. This ensures
    // that there is always a known pattern to stop the stimulation, even if the user
    // has not defined any profiles or sensations yet. The system profile is a
    // reserved profile that cannot be deactivated and serves as a fallback for the
    // stop command.
    profilesState.profiles = {
        "system": {
            "displayName": "System Profile",
            "name": "system",
            "author": "System",
            "isSystem": true, // This profile is not defined in the config but is always available
            "description": "This profile contains system sensations that are always available, " +
                "such as the 'stop' command to immediately stop all stimulation.",
            "sensations": [
                {
                    name: 'stop',
                    canLoop: false,
                    isPain: false,
                    description: 'Stop all signals immediately.'
                }
            ]
        }
    };

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

        // Validate that the sensation has a file. If not, log a warning and skip it.
        // Ignore warning for internal sensations like "stop" that do not require an audio file, as they are handled separately in the code.
        if (!sensation.file) {
            if (!profile.isSystem) {
                console.warn(`ESTIM: Pattern "${sensation.name}" has no audio file specified.`);
            }
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
    if (!settings.lastActiveProfiles.includes(profileId) && !profile.isSystem) {
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

    // Persist
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
    profilesState.profileDescriptions = '';

    // Iterate over all profiles and check if they are active. If they are, add their patterns and descriptions
    // to the list of available patterns for the AI tool.
    for (const [profileId, profile] of Object.entries(profilesState.profiles || {})) {

        // If the profile is not active, skip it. This allows users to have multiple profiles in their config
        //  but only activate the ones they want to use, without having to delete or comment out the others.
        if (!profile.isActive) {
            continue;
        }

        // Replace {{CH1}} and {{CH2}} (Case-Insensitive)
        const parsedProfileDesc = profile.description
            .replace(/\{\{estim_ch1\}\}/gi, ch1_text)
            .replace(/\{\{estim_ch2\}\}/gi, ch2_text);

        // Add the profile description to the list of available patterns for the AI tool.
        profilesState.profileDescriptions += `  - "${profile.name}": ${parsedProfileDesc}\n`;

        // Iterate over all sensations in the profile and create the description string for each sensation.
        // This will be used in the AI tool to help the AI understand what each sensation does and how it feels.
        for (const sensation of profile.sensations || []) {

            // Replace {{CH1}} and {{CH2}} (Case-Insensitive)
            let parsedSensationDesc = sensation.description
                .replace(/\{\{estim_ch1\}\}/gi, ch1_text)
                .replace(/\{\{estim_ch2\}\}/gi, ch2_text);

            // Add some specifiers at the end
            if (sensation?.duration > 0) {
                if (sensation?.canLoop) {
                    parsedSensationDesc = `${parsedSensationDesc} (cycle duration: ${sensation.duration.toFixed(1)} s, can loop indefinitely)`;
                }
                else {
                    parsedSensationDesc = `${parsedSensationDesc} (maximum duration: ${sensation.duration.toFixed(1)} s)`;
                }
            }

            // Add pain specifier at the beginning if it is a pain sensation. This helps the AI
            // to differentiate between pleasure and pain sensations, especially when they can
            // be made painful by increasing the intensity.
            if (sensation?.isPain) {
                parsedSensationDesc = `Pain signal. ${parsedSensationDesc}`;
            }

            // Store the processed string
            const uniquePatternName = `${profile.name}/${sensation.name}`;
            profilesState.patternNames.push(uniquePatternName);
            profilesState.patternDescriptions += `  - "${uniquePatternName}": ${parsedSensationDesc}\n`;
        }

        if (DEBUG_MODE) {
            console.log(`ESTIM: Active profile ${profile.displayName} with patterns: ${profilesState.patternNames.join(', ')}`);
        }
    }

    // Update Calibration dropdown with visual status indicators
    updateCalibrationDropdownUI();

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
 * @param {string} targetChannel The channel to play the signal on. Default is 'both'.
 * @param {boolean} quiet Suppress chat output when set to true. This is useful for internal calls where the message has already been announced or when the stimulation is triggered by a user action rather than the AI.
 * @param {number|null} overridePatternCalibration Optional calibration override value. If provided, this value will be used instead of the profile's default calibration.
 * @param {string|null} rawDuration The raw duration value as set by the AI, which can be a number in seconds or a percentage string (e.g. "100%"). This is used for scheduling the stop command when the duration is specified as a percentage of the audio file length.
 * @param {number|null} overrideAudioCalibration Optional audio calibration override value. If provided, this value will be used instead of the profile's default audio calibration.
 * @returns {Promise<boolean>} Returns a promise that resolves to true if the signal was played successfully, false otherwise.
 */
async function playEstimSignal(pattern, intensity = 10, duration = 0, targetChannel = 'both', quiet = false, overridePatternCalibration = null, rawDuration = null, overrideAudioCalibration = null) {
    const settings = getSettings();

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
    // Enable stealth mode to not update the pattern, intensity and duration in the state
    stopAllEstimSignals(true, 10, true);

    let targetVolume = 0;
    if (overrideAudioCalibration !== null) {
        targetVolume = overrideAudioCalibration;
    }
    else {
        // Read calibration data
        const minCalibration = settings.minCalibration || ESTIM_MIN_AUDIOVOLUME;
        const maxPleasureCalibration = settings.maxPleasureCalibration || ESTIM_MAX_PLEASURE_AUDIOVOLUME;
        const maxPainCalibration = settings.maxPainCalibration || ESTIM_MAX_PAIN_AUDIOVOLUME;

        // Make sure that the limits are correctly set. Assume that max pain is absolutely, so max pleasure must be below that.
        // And minimum must be below max pleasure
        const maxPain = Math.max(0, maxPainCalibration);
        const maxPleasure = Math.max(0, Math.min(maxPleasureCalibration, maxPain - 0.01));
        const minVol = Math.max(0, Math.min(minCalibration, maxPleasure - 0.01));

        // Calculate target volume
        intensity = Math.max(0, Math.min(200, parseInt(intensity) || 10));
        if (intensity > 0) {
            if (intensity <= 100) {
                targetVolume = minVol + ((intensity - 1) / 99) * (maxPleasure - minVol);
            } else {
                targetVolume = maxPleasure + ((intensity - 101) / 99) * (maxPain - maxPleasure);
            }
        }

        // Determine individual calibration for this pattern. This allows users
        // to fine-tune the intensity of each pattern to their liking, which is
        // especially important for pain sensations where a small increase in
        // intensity can make a big difference in the perceived sensation.
        // The calibration is applied as a multiplier to the target volume,
        // so a calibration of 1.0 means no change, while a calibration of
        // 0.5 would reduce the intensity by half and a calibration of 2.0
        // would double it.
        // 1st priority: The temporary slider value from the "Test" button
        // 2nd priority: Your permanently saved value from the settings
        // 3rd priority: The base value from the profiles.json (or 1.0)
        let finalCalib = 1.0;
        if (overridePatternCalibration !== null) {
            finalCalib = overridePatternCalibration;
        } else if (settings.customCalibrations[pattern] !== undefined) {
            finalCalib = settings.customCalibrations[pattern];
        } else {
            finalCalib = sensation.calibration || 1.0;
        }

        // Apply calibration to target volume. Including clipping
        targetVolume = targetVolume * finalCalib;
        targetVolume = Math.min(maxPainCalibration, targetVolume);
        targetVolume = Math.max(0, targetVolume);
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

    // Channel selection with stereo panning. This allows the AI to choose
    // to stimulate only one channel (e.g. only genitals or only buttocks)
    // or both channels at the same time, which adds more variety and control
    // over the sensations.
    const panner = audioState.audioContext.createStereoPanner();
    if (targetChannel === 'ch1') {
        panner.pan.setValueAtTime(-1, now); // 100% left
    } else if (targetChannel === 'ch2') {
        panner.pan.setValueAtTime(1, now);  // 100% right
    } else {
        panner.pan.setValueAtTime(0, now);  // both channels equally (default)
    }

    // Connect audio graph: Source -> Panner -> Gain -> Destination
    audioState.audioSource.connect(panner);
    panner.connect(audioState.audioGain);

    if (!settings.simulationOnly) {
        // Normal mode: Connect to the destination so the audio is actually played.
        // This is the default behavior when the AI triggers a sensation.
        audioState.audioGain.connect(audioState.audioContext.destination);
    } else {
        // Simulation only mode: Don't connect to the destination, which effectively mutes
        // the audio output. This is useful for testing and debugging without actually playing the sound.
        if (DEBUG_MODE) console.log(`ESTIM: 🔇 Simulation Only active. Audio hardware disconnected.`);
    }

    // Set audio cancel timer if a specific duration was set
    if (duration > 0) {
        // Set looping to repeat the audio in case the duration
        // is set longer than the duration of the file.
        audioState.audioSource.loop = true;
        audioState.looping = false;

        // Start timer
        audioState.timerId = setTimeout(() => {
            audioState.timerId = null; // Remove reference to this timeout
            stopAllEstimSignals(true, 15); // Stealth mode: Don't erase pattern info
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

    // Start playback
    audioState.audioSource.start(now);

    // Smooth exponential ramp up (sounds natural)
    audioState.audioGain.gain.exponentialRampToValueAtTime(targetVolume, now + fadeInTime);

    // Remember everything
    audioState.startTime = now;
    audioState.playing = true;
    audioState.pattern = pattern;
    audioState.intensity = intensity;
    audioState.duration = duration;
    audioState.targetChannel = targetChannel;

    // Console + system message
    if (DEBUG_MODE) console.log(`ESTIM: 🎵 Playing ${sensation.file} | intensity ${intensity}% | fade-in 12ms`);

    if (!quiet && !settings.blindfoldModes) {
        let durationText = '';
        if (duration > 0) {
            durationText = duration + 's';
        } else if (duration < 0) {
            durationText = 'continuously';
        } else {
            durationText = 'native length';
        }
        if (rawDuration !== null && String(duration) !== String(rawDuration)) {
            durationText += ` (llm: ${rawDuration})`;
        }


        //const context = SillyTavern.getContext();
        //context.sendSystemMessage('generic', `Sensation "${pattern}" will be played with intensity ${intensity}% for ${duration > 0 ? duration : 'indefinite'} seconds`, { isSmallSys: true });
        let toastrDuration = duration > 0 ? duration * 1000 : 8000; // Show the toast for the duration of the sensation, or 8 seconds for indefinite sensations
        toastrDuration = Math.min(toastrDuration, 15000); // Cap the toast duration at 15 seconds to avoid excessively long toasts for very long sensations
        toastrDuration = Math.max(toastrDuration, 4000); // Minimum duration of 4 seconds to ensure the user has enough time to read the message for short sensations
        const toastrText = `${pattern}, intensity ${intensity}%, ` +
            `duration ${durationText}, ${targetChannel}`;
        console.log(`ESTIM: Showing toast "${toastrText}"`);
        toastr.info(
            toastrText,
            'Estim Immersion', // no title
            {
                timeOut: toastrDuration,// Duration in ms before the toast disappears
                extendedTimeOut: 3000,  // Duration in ms before the toast disappears after a user hovers over it
                closeButton: true       // Show a close button on the toast for manual dismissal
            }
        );
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
function stopAllEstimSignals(stealth = false, fadeOutMs = 15, quiet = false) {

    // Stop playing audio
    const now = audioState.audioContext.currentTime;
    try {
        if (audioState.audioGain) {
            audioState.audioGain.gain.cancelScheduledValues(now);
            audioState.audioGain.gain.exponentialRampToValueAtTime(0.001, now + fadeOutMs / 1000);
            audioState.audioGain = null;
        }
        if (audioState.audioSource) {
            audioState.audioSource.onended = null; // Remove event listener to prevent it from firing after we stopped the audio
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

    // If stealth is true, we do not update the pattern, intensity and duration in the state,
    // which allows us to keep the old values for the next playback. This is useful when we
    // want to quickly stop the audio before starting a new one, without losing the information
    // what we played before.
    if (!stealth) {
        audioState.startTime = now;
        audioState.pattern = 'stop';
        audioState.intensity = 0;
        audioState.duration = -1;
    }

    if (DEBUG_MODE) console.log(`ESTIM: All estim signals stopped (fade-out ${fadeOutMs}ms)`);
    //if (!quiet) {
    //    SillyTavern.getContext().sendSystemMessage('generic', 'Estim stimulation stopped.', { isSmallSys: true });
    //}
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
async function setupAutoAudioUnlock() {
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


/**
 * Generates a JSON-like string of the current audio state including
 * information how the sensation started.
 */
function getAudioStateString() {
    // State when the sensation was started
    let state = `{ "last_action_triggered_by_you": `;
    if (audioState.pattern) {
        state += `{ "pattern": "${audioState.pattern}", "intensity": ${audioState.intensity}`;
        if (audioState.looping) {
            state += `, "mode": "looping" }`;
        } else if (audioState.duration === 0) {
            state += `, "mode": "native_duration" }`;
        } else {
            state += `, "duration_seconds": ${audioState.duration} }`;
        }
        state += `, "target_channel": "${audioState.targetChannel || 'both'}"`;
    }
    else {
        state += `"None"`;
    }

    // Current real-time state of the audio (which might differ from the last triggered
    // action if the duration is long or looping)
    state = state + `, "current_real_time_state": `
    if (audioState.playing) {
        const elapsedTime = audioState.audioContext.currentTime - audioState.startTime;
        state += `{ "pattern": "${audioState.pattern}", "intensity": ${audioState.intensity}, `;
        state += `"elapsed_time_seconds": ${elapsedTime.toFixed(1)}`;

        if (audioState.looping) {
            state += `, "mode": "continuous_loop" }`;
        }
        else {
            const remaining = Math.max(0, audioState.duration - elapsedTime);
            state += `, "remaining_duration_seconds": ${remaining.toFixed(1)} }`;
        }
        state += `, "target_channel": "${audioState.targetChannel || 'both'}"`;
    }
    else {
        state += `"INACTIVE (No sensation currently inflicted)"`;
    }

    state += ` }`;
    return state;
}


// ==== RESTRICTED REMOTE CONTROL ====


/**
 * Shows the remote control with the given parameters. This is called
 * when the AI tool "remote_control" is triggered during the narration,
 * allowing the AI to give the user temporary control over certain
 * aspects of the stimulation (e.g. intensity, pattern selection, etc.)
 * through an interactive widget on the screen. The parameters define
 * which controls to show and how they should behave.
 * @param {string} pattern The calling pattern that triggered the remote control.
 * @param {*} remoteControlConfig The parameters for the remote control widget.
 */
function showRemoteControlWidget(pattern, remoteControlConfig = null) {
    if (DEBUG_MODE) {
        console.log('ESTIM: Remote control parameters received:', remoteControlConfig);
    }

    // Always remember the calling pattern and the configuration
    restrRemoteState.calibrationPattern = pattern;
    restrRemoteState.remoteControlConfig = remoteControlConfig;

    // Do the UI configuration based on the parameters sent by the AI.
    // This allows the AI to customize the remote control for each situation.
    if (!configureRemoteControlWidget()) {
        // Nothing to show, so we do not open the remote control at all.
        // This allows the AI to simply call "showRemoteControlWidget" with
        // parameters that lead to no enabled modules to hide the remote control,
        // without having to call the separate "hideRemoteControlWidget" function.
        return false;
    }

    // Make it visible
    if ($('#estim_remote_container').hasClass('estim-closedDrawer')) {
        $('#estim_remote_container').addClass('estim-openDrawer');
        $('#estim_remote_container').removeClass('estim-closedDrawer');

        // Update state
        restrRemoteState.isOpen = true;

        if (DEBUG_MODE) {
            console.log('ESTIM: Showing restricted remote control widget');
        }
    }
    return true;
}


/**
 * Configures the remote control UI elements according to the saved configuration
 * with the given parameters. This is called by the "showRemoteControlWidget"
 * function to set up the remote control based on the AI's instructions.
 */
function configureRemoteControlWidget() {

    // Hide everything first and then show only the enabled modules.
    // This ensures a clean state and avoids any conflicts between modules,
    // especially when the remote control is triggered multiple times with different configurations.
    $('#estim_remote_calibration').addClass('estim-hidden');
    $('#estim_remote_trick_module').addClass('estim-hidden');
    $('#estim_remote_stop_module').addClass('estim-hidden');

    // Check if there is at least one module enabled. If not, we do not show the
    // remote control at all, because it would be useless and confusing to the user.
    const isAnyModuleEnabled =
        restrRemoteState.remoteControlConfig?.calibration_module?.enabled ||
        restrRemoteState.remoteControlConfig?.stop_module?.enabled ||
        restrRemoteState.remoteControlConfig?.trick_or_treat_module?.enabled;

    // Handle special case of hiding in the show function to avoid having
    // to implement the hiding logic in the AI tool separately. This allows
    // the AI to simply call "showRemoteControlWidget" with all modules disabled
    // to hide the remote control, which is more intuitive and keeps
    // all remote control related logic in one place.
    if (!isAnyModuleEnabled) {
        hideRemoteControlWidget();
        return false;
    }

    // Configure CALIBRATION module
    if (restrRemoteState.remoteControlConfig?.calibration_module?.enabled) {
        $('#estim_remote_calibration').removeClass('estim-hidden');

        // Set intro text
        $('#estim_remote_intro_text').text(restrRemoteState.remoteControlConfig.calibration_module.intro_text || '');

        // Read the stored values (or default values)
        const settings = getSettings();
        const minCalibration = settings.minCalibration || ESTIM_MIN_AUDIOVOLUME;
        const maxPleasureCalibration = settings.maxPleasureCalibration || ESTIM_MAX_PLEASURE_AUDIOVOLUME;
        const maxPainCalibration = settings.maxPainCalibration || ESTIM_MAX_PAIN_AUDIOVOLUME;

        $('#estim_calib_min_slider').val(minCalibration);
        $('#estim_calib_pleasure_slider').val(maxPleasureCalibration);
        $('#estim_calib_pain_slider').val(maxPainCalibration);

        // increase_only logic
        if (isTrueBoolean(String(restrRemoteState.remoteControlConfig.calibration_module?.increase_only))) {
            $('#estim_remote_calibration').addClass('estim-increase-only');

            // sets the HTML 'min' attribute to the current value
            $('#estim_calib_min_slider').attr('min', minCalibration);
            $('#estim_calib_pleasure_slider').attr('min', maxPleasureCalibration);
            $('#estim_calib_pain_slider').attr('min', maxPainCalibration);
        } else {
            $('#estim_remote_calibration').removeClass('estim-increase-only');

            // Restore standard limits
            $('#estim_calib_min_slider').attr('min', 0.01);
            $('#estim_calib_pleasure_slider').attr('min', 0.01);
            $('#estim_calib_pain_slider').attr('min', 0.01);
        }

        // Do not allow further modules, so always return to the caller
        return true;
    }

    // Configure TRICK OR TREAT module (must sit before STOP module because of the shared button)
    if (restrRemoteState.remoteControlConfig?.trick_or_treat_module?.enabled) {
        $('#estim_remote_trick_module').removeClass('estim-hidden');
        $('#estim_remote_intro_text').text(restrRemoteState.remoteControlConfig.trick_or_treat_module.intro_text || '');
        $('#estim_remote_trick_btn').text(restrRemoteState.remoteControlConfig.trick_or_treat_module.button_label || 'Reveal Secret');

        // Return now. This hides the STOP module until it is activated (if enabled by the AI)
        return true;
    }

    // Configure STOP module (only visible if Trick-Module is OFF)
    if (restrRemoteState.remoteControlConfig?.stop_module?.enabled) {
        $('#estim_remote_stop_module').removeClass('estim-hidden');
        $('#estim_remote_intro_text').text(restrRemoteState.remoteControlConfig.stop_module.intro_text || '');
        $('#estim_remote_stop_btn').text(restrRemoteState.remoteControlConfig.stop_module.button_label || 'STOP');

        return true;
    }

    return false;
}


/**
 * Hides the restricted remote control widget by changing its CSS classes.
 */
function hideRemoteControlWidget() {
    if ($('#estim_remote_container').hasClass('estim-openDrawer')) {
        $('#estim_remote_container').addClass('estim-closedDrawer');
        $('#estim_remote_container').removeClass('estim-openDrawer');

        // Clear state
        restrRemoteState.isOpen = false;
        restrRemoteState.calibrationPattern = null;

        if (DEBUG_MODE) {
            console.debug('ESTIM: Hiding restricted remote control widget');
        }
    }
    return true;
}


// ==== AI TOOLS & COMMANDS ====


/**
 * Register function tools for this extension. This allows the AI to call these
 * functions during narration.
 * @returns {Promise<void>}
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

        // Get current channel names with fallback to defaults if not set. These will be used to
        // replace the placeholders in the profile descriptions.
        const settings = getSettings();
        const ch1_text = settings.channel1 || DEFAULT_CHANNEL_1_NAME;
        const ch2_text = settings.channel2 || DEFAULT_CHANNEL_2_NAME;

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
                    //description: 'Intensity 1-100 (pleasure intensity), 101-200 (pain intensity). Every sensation ' +
                    //    'can be made painful by increasing its intensity to pain intensity. This means that normal ' +
                    //    'pleasure sensations will become pain sensations at intensities greater 100, whereas ' +
                    //    'pain sensations will always be painful regardless of a certain intensity threshold. ' +
                    //    'To unlock painful intensities, "is_pain_intensity" must be set to true as a safety measure. ' +
                    //    'Default is 10 (low intensity). The intensity is a multiplier to the intensity indication ' +
                    //    'in the description.\n' +
                    //    'Baseline guidance for matching narration: Select the intensity according to the required ' +
                    //    'intensity to match the current tension in the story. Increase the intensity slowly over ' +
                    //    'multiple turns. Never rush to the highest intensity right from the start. Build an escalation ' +
                    //    'over multiple turns.',
                    description: 'Intensity scale: 1-100 (Pleasure/Tingle), 101-200 (Pain/Hard). ' +
                        'RULES FOR INTENSITY: ' +
                        '1. PACING: Build the intensity slowly over multiple turns. Do not jump to ' +
                        'maximum right away unless delivering a severe, sudden punishment. ' +
                        '2. SAFETY: To access painful intensities > 100, "is_pain_intensity" MUST ' +
                        'be true. Otherwise, the signal is clamped at 100. ' +
                        '3. NARRATIVE SYNC: A gentle tease should be 10-30. A strong, edge-pushing ' +
                        'vibration 70-100. A cruel shock 150+.'
                },
                is_pain_intensity: {
                    type: 'boolean',
                    description: 'Whether pain intensity (101-200) shall be available. Default is false.',
                },
                duration: {
                    type: 'string',
                    //description: 'Duration of the inflicted sensation. Default is 0, which plays ' +
                    //    'the pattern for its native pattern length as indicated in the pattern description. ' +
                    //    'Provide a fixed number for absolute seconds (e.g. "5", "2.5") or a percentage ' +
                    //    'based on the narrative length (e.g. "100%", "50%"). "100%" calculates the exact ' +
                    //    'reading time of your response. "-1" loops the pattern continuously. ' +
                    //    'Baseline guidance: Use fixed short times (e.g. "2") for brief zaps, and mainly ' +
                    //    'percentages for sensations accompanying your narrative.',
                    description: 'Controls the pacing of the physical sensation. ' +
                        'CRITICAL TIMING RULES: ' +
                        '1. BACKGROUND FEELING (Percentages): Use "100%" or "50%" for sensations ' +
                        'that accompany your dialogue (e.g., a vibrator humming while you speak). ' +
                        '"100%" makes the audio last exactly as long as it takes the user to read ' +
                        'your response. ' +
                        '2. SUDDEN IMPACT (Seconds): Use short fixed numbers (e.g., "0.5", "2") for ' +
                        'brief, sharp events in the story like a slap, a sudden zap, or a quick pinch. ' +
                        '3. LINGERING STATE (-1): Use "-1" to loop the sensation infinitely. Use ' +
                        'this ONLY when explicitly leaving a device running to torment or tease ' +
                        'the user while waiting for their next reply. ' +
                        '4. NATIVE (0): Use "0" to play the pattern exactly once for its native ' +
                        'length.'
                },
                target_channel: {
                    type: 'string',
                    enum: ['both', 'ch1', 'ch2'],
                    description: `Which body part to stimulate. Select 'both' to stimulate ${ch1_text} and ` +
                        `${ch2_text}. Select 'ch1' to strictly isolate the signal to: ${ch1_text}. ` +
                        `Select 'ch2' to strictly isolate the signal to: ${ch2_text}. Default is 'both'. ` +
                        `Baseline guidance for matching narration: If the narration explicitly focuses on one body part, ` +
                        `select the corresponding channel to increase immersion. For more general sensations ` +
                        `or when both body parts are involved in the narration, select 'both'.`
                },
                who: {
                    type: 'string',
                    description: 'The name of the character to inflict the sensation on.',
                },
                restricted_remote_control: {
                    type: 'object',
                    description: 'CONTROLS THE USER\'S UI. Renders a physical remote control on the user\'s actual screen. ' +
                        'CRITICAL RULES FOR USAGE: ' +
                        '1. SCARCITY: Do NOT spam this UI. By default, KEEP IT HIDDEN (disable all modules) to enforce the user\'s helplessness and maintain immersion. ' +
                        '2. NARRATIVE SYNC: Only show the remote if your character explicitly grants the user a choice, a test of endurance, or a moment of mercy in the dialogue. ' +
                        '3. THE TRICK-OR-TREAT MODULE (Russian Roulette): The pattern/intensity/duration you set in this tool call will be kept SECRET and will NOT play automatically. ' +
                        'A button appears. The user must click it to receive the hidden sensation. Use this for tests of courage or blind choices. ' +
                        '4. THE STOP MODULE (Panic Button): Enable this as a psychological taunt ("Go ahead, press stop if you are too weak") or a genuine safety mechanism during extreme scenes. ' +
                        'If combined with Trick-or-Treat, it will appear AFTER the user presses the secret button. ' +
                        '5. THE CALIBRATION MODULE: Use this BEFORE a severe scene to force the user to set physical limits. (Can only be used alone). ' +
                        'Use "increase_only: true" in the calibration module to let the user dial the pain/pleasure UP, but never down (SADISTIC TRAP). ' +
                        'If the character is completely dominating and allows zero control, you MUST hide the remote by disabling all modules.',
                    properties: {
                        stop_module: {
                            type: 'object',
                            description: 'A psychological safeword/panic button on the user\'s screen.',
                            properties: {
                                enabled: { type: 'boolean' },
                                intro_text: { type: 'string', description: 'A short, in-character taunt or instruction (e.g., "Beg for mercy and press it.", "Don\'t you dare touch this.").' },
                                button_label: { type: 'string', description: 'What the button itself says (e.g., "I GIVE UP", "STOP", "MERCY").' }
                            }
                        },
                        trick_or_treat_module: {
                            type: 'object',
                            description: 'A "Russian Roulette" button. Keeps your selected pattern SECRET until the user gathers the courage to press it. Triggers telemetry about their bravery.',
                            properties: {
                                enabled: { type: 'boolean' },
                                intro_text: { type: 'string', description: 'Taunt the user to press it (e.g., "Let\'s play a game. Press it if you dare.").' },
                                button_label: { type: 'string', description: 'What the button says (e.g., "Take the Risk", "Accept Punishment").' }
                            }
                        },
                        calibration_module: {
                            type: 'object',
                            description: 'Forces the user to lock in their physical limits for the upcoming scene.',
                            properties: {
                                enabled: { type: 'boolean' },
                                increase_only: { type: 'boolean', description: 'If true, the user can only slide the limits HIGHER. They cannot decrease them. Use this for sadistic choices.' },
                                intro_text: { type: 'string', description: 'In-character instruction (e.g., "Set your limits. Choose wisely.").' }
                            }
                        }
                    }
                }
            },
            required: ['pattern', 'who', 'restricted_remote_control'],
        };

        registerFunctionTool({
            name: 'inflict_physical_sensation',
            displayName: 'Inflict Physical Sensation',
            //description: 'Use this tool to inflict a real physical sensation on the user\'s body. ' +
            //    'Call this seamlessly while narrating. Use the descriptions in the "pattern" parameter to ' +
            //    'select the physical sensation that matches the narraded story best. Select intensity and ' +
            //    'duration according to the rules in the parameter descriptions. Enable or disable a ' +
            //    'restricted remote control panel that allows the user to partially control the ' +
            //    'sensation. Physical sensations are grouped into profiles. Sensations in the ' +
            //    'same profile should be used together to create a more complex sensation experience. ' +
            //    'The following profiles are currently active:\n' + profilesState.profileDescriptions,
            description: 'CRITICAL NARRATIVE TOOL: This bridges the gap between your text and the ' +
                'user\'s physical reality. Whenever your character physically touches, teases, shocks, ' +
                'or stimulates the user in the story, you MUST call this tool to make them actually feel ' +
                'it on their body. You can also deploy a restricted remote control UI to give the user ' +
                'sadistic choices or limited safety mechanisms. Sensations are grouped into profiles. ' +
                'Sensations in the same profile should be used together to create a realistic, layered ' +
                'experience.\nActive profiles:\n' + profilesState.profileDescriptions,
            parameters: estimSchema,
            stealth: true,
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
                if (!args?.restricted_remote_control) {
                    return `Missing required parameter "restricted_remote_control". Please specify if ` +
                        `the restricted remote control panel should be enabled.`;
                }

                console.log('ESTIM: DEBUG Restricted remote control parameters received:', args.restricted_remote_control);

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

                // Store the parameters for the next signal
                scheduledNextAction.pattern = args.pattern;
                scheduledNextAction.intensity = intensityValue;
                scheduledNextAction.durationRaw = args.duration; // Store the raw value for reference
                scheduledNextAction.targetChannel = args.target_channel || 'both';
                scheduledNextAction.remoteControlConfig = args.restricted_remote_control;
                scheduledNextAction.pending = true;

                return `Stimulation "${scheduledNextAction.pattern}" inflicted. ` +
                    `Restricted remote control will ` +
                    `${scheduledNextAction.remoteControlConfig.show_remote ? '' : 'not '} ` +
                    `be shown to the user. `;
            },
            formatMessage: () => '',
        });

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
                    if (!scheduledNextAction.pending) {

                        // No new signal scheduled? No active audio playing?
                        // This means inactivity -> we deliberately remove the pattern info to indicate that
                        if (!audioState.playing) {
                            stopAllEstimSignals();
                            hideRemoteControlWidget();
                            audioState.pattern = null;
                        }
                        return;
                    }

                    // Calculate the final duration in seconds based on the raw input.
                    // This allows us to support both fixed durations (e.g. "5", "2.5") and
                    // percentage-based durations (e.g. "100%", "50%") that adapt to the
                    // narrative length.
                    let finalDurationSeconds = 0;
                    const rawDur = String(scheduledNextAction.durationRaw || "100%").trim();
                    if (rawDur === '-1') {
                        finalDurationSeconds = -1; // Loop indefinitely until stopped by another command
                    }
                    else if (rawDur === '0') {
                        finalDurationSeconds = 0; // Play the pattern for its native length
                    }
                    else if (rawDur.endsWith('%')) {
                        // Get last message from chat
                        const chat = SillyTavern.getContext().chat;
                        const lastMessage = chat.length > 0 ? chat[chat.length - 1].mes : "";

                        // Count words in the last message to estimate reading time.
                        // We split by whitespace and filter out empty strings.
                        const wordCount = lastMessage.split(/\s+/).filter(word => word.length > 0).length;

                        // Calculate reading time (~3 words per sec) * stretch
                        const readingTimeSeconds = (wordCount / 3) * settings.durationStretchFactor;

                        // Apply percentage-based duration
                        const percent = parseInt(rawDur.replace('%', '')) / 100;
                        finalDurationSeconds = Math.max(1, Math.round(readingTimeSeconds * percent));

                        if (DEBUG_MODE) {
                            console.log(`ESTIM: Smart Duration, ${wordCount} words = ${readingTimeSeconds}s. ` +
                                `Applied ${rawDur} = ${finalDurationSeconds}s`);
                        }
                    }
                    else {
                        // Fallback: Try to parse as fixed duration in seconds
                        finalDurationSeconds = parseFloat(rawDur);
                    }

                    scheduledNextAction.pending = false;
                    scheduledNextAction.finalDurationSeconds = finalDurationSeconds;

                    // Show the remote control (or disable it)
                    if (scheduledNextAction.remoteControlConfig) {
                        showRemoteControlWidget(scheduledNextAction.pattern, scheduledNextAction.remoteControlConfig);
                    }
                    else {
                        hideRemoteControlWidget();
                    }

                    // Detect if the audio should automatically or manually start for the next action
                    // Right now this is always true with the exception of calibration runs
                    const isManualStart =
                        scheduledNextAction.remoteControlConfig?.calibration_module?.enabled ||
                        scheduledNextAction.remoteControlConfig?.trick_or_treat_module?.enabled;

                    // In automatic mode start right away
                    if (!isManualStart) {
                        // Play the scheduled signal with the calculated duration
                        await playEstimSignal(scheduledNextAction.pattern,
                            scheduledNextAction.intensity, finalDurationSeconds,
                            scheduledNextAction.targetChannel, false, null, rawDur);
                    }
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
        name: 'estim-inflict',
        callback: async (args, value) => {
            const quiet = isTrueBoolean(String(args.quiet));
            const targetChannel = args.target_channel || 'both';
            if (DEBUG_MODE) console.log('ESTIM command called with arguments:', args, 'and unnamed value:', value);
            await playEstimSignal(args.pattern, args.intensity, args.duration, targetChannel, quiet);
            return `ESTIM stimulation triggered: pattern=${args.pattern}, intensity=${args.intensity}, duration=${args.duration}s, channel=${targetChannel}.`;
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
                enumProvider: () => profilesState.patternNames.length > 0
                    ? profilesState.patternNames.map(p => new SlashCommandEnumValue(p))
                    : [new SlashCommandEnumValue('(loading...)')]
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
            SlashCommandNamedArgument.fromProps({
                name: 'target_channel',
                description: 'Which channel to play on: both, ch1, or ch2. Default is both.',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: String('both'),
                enumProvider: () => ['both', 'ch1', 'ch2'].map(val => new SlashCommandEnumValue(val))
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
                // Bonus: Autocomplete for profile names in chat!
                enumProvider: () => Object.keys(profilesState.profiles).map(p => new SlashCommandEnumValue(p))
            })
        ],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'estim-remote',
        callback: async (args, value) => {
            const pattern = args.pattern || profilesState.patternNames[0] || 'system/stop';

            // Eine "All-Inclusive" Konfiguration für den manuellen Aufruf
            const manualConfig = {
                trick_or_treat_module: {
                    enabled: true,
                    intro_text: 'Trick or Treat: A Secret Button',
                    button_label: 'DARE TO PRESS'
                },
                stop_module: {
                    enabled: true,
                    intro_text: 'Manual Override: Panic Button',
                    button_label: 'EMERGENCY STOP'
                }
            };

            showRemoteControlWidget(pattern, manualConfig);
            return `ESTIM: Remote control opened for pattern "${pattern}".`;
        },
        helpString: 'Manually show the restricted remote control.',
        returns: 'Success message.',
        unnamedArgumentList: [],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'pattern',
                description: 'The pattern to preload into the calibration sliders.',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => profilesState.patternNames.length > 0
                    ? profilesState.patternNames.map(p => new SlashCommandEnumValue(p))
                    : [new SlashCommandEnumValue('(loading...)')]
            })
        ]
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'estim-calibrate',
        callback: async (args, value) => {
            // Which pattern should be tested in the calibration?
            // Fallback to the first available pattern if none is specified
            const pattern = args.pattern || profilesState.patternNames[0] || 'system/stop';

            // An "All-Inclusive" configuration for manual invocation
            const manualConfig = {
                calibration_module: {
                    enabled: true,
                    increase_only: false,
                    intro_text: `Manual Override: Calibrating "${pattern}"`
                }
            };

            showRemoteControlWidget(pattern, manualConfig);
            return `ESTIM: Remote control calibration opened for pattern "${pattern}".`;
        },
        helpString: 'Manually open the calibration remote control.',
        returns: 'Success message.',
        unnamedArgumentList: [],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'pattern',
                description: 'The pattern to preload into the calibration sliders.',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: () => profilesState.patternNames.length > 0
                    ? profilesState.patternNames.map(p => new SlashCommandEnumValue(p))
                    : [new SlashCommandEnumValue('(loading...)')]
            })
        ]
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'estim-remote-close',
        callback: async (args, value) => {
            hideRemoteControlWidget();
            return `ESTIM: Remote control hidden.`;
        },
        helpString: 'Manually hide the restricted remote control.',
        returns: 'Confirmation message.',
        namedArgumentList: []
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'estim-status',
        callback: async (args, value) => {
            const statusString = getAudioStateString();

            console.log("ESTIM Status:", statusString);
            toastr.info(statusString, "ESTIM Status", { timeOut: 6000 });
            return `ESTIM status is: ${statusString}`;
        },
        helpString: 'Get the current e-stim state.',
        returns: 'Stimulation state string.',
        namedArgumentList: []
    }));
}


// ==== BUILD UI ELEMENTS ====


/**
 * Register UI elements for this extension. This adds buttons, settings panels,
 * or other interactive elements to the SillyTavern interface.
 */
async function registerUiElements() {

    await registerUiSettings();
    await registerUiRemote();
    await registerUiProfiles();
    await registerUiChannelNames();
    await registerUiBlindfoldMode();
    await registerUiSimulationOnly();
    await registerUiStretchFactor();
    await registerUiStopButton();
    await registerUiCalibrationStudio();
    await registerUiMacros();
}


/**
 * Registers UI elements for managing the extension settings.
 */
async function registerUiSettings() {
    const settingsHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    const getSettingsContainer = () => $(document.getElementById('estim_container') ?? document.getElementById('extensions_settings2'));
    getSettingsContainer().append(settingsHtml);
}


/**
 * Registers UI elements for the remote control panel.
 */
async function registerUiRemote() {
    const remoteHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'remote');

    // We attach it at the very top of the character info block in the right
    // sidebar, so it is always visible and easily accessible for the user.
    // This allows users to quickly trigger sensations or stop them without
    // having to scroll or search for the controls, which is especially
    // important during intense story moments when quick reactions are needed.
    const $rightMenuInfoBlock = $('#rm_info_block');
    if ($rightMenuInfoBlock.length) {
        $rightMenuInfoBlock.prepend(remoteHtml);
    } else {
        // Fallback, in case the theme is structured slightly differently
        $('#rightNavHolder').prepend(remoteHtml);
    }

    // Stop button event listener
    $('#estim_remote_stop_btn').on('click', () => {
        stopAllEstimSignals();
        hideRemoteControlWidget();

        // Nachricht für das LLM in die Queue pushen
        restrRemoteState.telemetryQueue.push(
            `The user clicked the Panic/Stop button on the remote control ` +
            `and aborted the stimulation. React accordingly! ` +
            `Your button introduction was: "${$('#estim_remote_intro_text').text()}". ` +
            `and your button label was: "${$('#estim_remote_stop_btn').text()}". `
        );
        toastr.info("Safeword triggered. Waiting for your next chat turn.");
    });

    // Trick-or-Treat Button Event
    $('#estim_remote_trick_btn').on('click', async () => {
        if (!restrRemoteState.remoteControlConfig?.trick_or_treat_module?.enabled) return;

        // Hide the Trick-or-Treat button immediately after it's pressed to prevent
        // multiple clicks and to increase the psychological impact of the "one chance" choice.
        restrRemoteState.remoteControlConfig.trick_or_treat_module.enabled = false;

        // Reconfigure the remote to reflect the change (hide the button)
        // Now shows the STOP button if it is enabled, otherwise hides the remote entirely
        configureRemoteControlWidget();

        // Telemetry to the KI
        restrRemoteState.telemetryQueue.push(
            `The user was brave and clicked the secret button! The hidden sensation is now playing.`
        );

        // Play the secret stimulation
        await playEstimSignal(
            scheduledNextAction.pattern,
            scheduledNextAction.intensity,
            scheduledNextAction.finalDurationSeconds,
            scheduledNextAction.targetChannel,
            false,
            null,
            scheduledNextAction.durationRaw
        );
    });

    // Test buttons for the calibration event listener
    const setupTestButton = (btnId, sliderId) => {
        $(btnId).on('click', async function () {
            const isPlaying = $(this).hasClass('estim-playing');

            // Stop currently playing signal (if any) and reset all buttons
            stopAllEstimSignals();
            $('.estim-calib-play-btn').removeClass('estim-playing').text('▶');

            if (!isPlaying && restrRemoteState.calibrationPattern) {
                // Let the button visually "lock" in place to indicate that the signal
                // is playing. This gives the user feedback on the current state and
                // allows them to stop the signal by clicking the button again.
                $(this).addClass('estim-playing').text('⏹');

                // We read the set intensity (0.0 - 1.0) from the slider
                const sliderIntensity = parseFloat($(sliderId).val());

                // We play the signal on a loop (-1). Intensity is 'don't care' here, because
                // the calibration pattern will ignore it and use the slider value instead. Only
                // requirement is to set it to a value >0 to avoid interpreting the call as a STOP
                await playEstimSignal(restrRemoteState.calibrationPattern, 10, -1, 'both', true, null, null, sliderIntensity);
            }
        });
    };

    setupTestButton('#estim_calib_min_play', '#estim_calib_min_slider');
    setupTestButton('#estim_calib_pleasure_play', '#estim_calib_pleasure_slider');
    setupTestButton('#estim_calib_pain_play', '#estim_calib_pain_slider');

    // Save button for the calibration values
    $('#estim_remote_save_calib').on('click', async () => {
        stopAllEstimSignals();
        $('.estim-calib-play-btn').removeClass('estim-playing').text('▶');
        hideRemoteControlWidget();

        const minCalibration = $('#estim_calib_min_slider').val();
        const maxPleasureCalibration = $('#estim_calib_pleasure_slider').val();
        const maxPainCalibration = $('#estim_calib_pain_slider').val();

        const settings = getSettings();
        if (!settings.remoteThresholds) settings.remoteThresholds = {};

        // Remember old values
        const minCalibrationOld = settings.minCalibration || ESTIM_MIN_AUDIOVOLUME;
        const maxPleasureCalibrationOld = settings.maxPleasureCalibration || ESTIM_MAX_PLEASURE_AUDIOVOLUME;
        const maxPainCalibrationOld = settings.maxPainCalibration || ESTIM_MAX_PAIN_AUDIOVOLUME;

        // Save new values
        settings.minCalibration = minCalibration;
        settings.maxPleasureCalibration = maxPleasureCalibration;
        settings.maxPainCalibration = maxPainCalibration;
        await updateSettings();

        // Generate telemetry for the LLM
        const minDiff = minCalibration > minCalibrationOld ? 'Increased' : (minCalibration < minCalibrationOld ? 'Decreased' : 'Unchanged');
        const pleasureDiff = maxPleasureCalibration > maxPleasureCalibrationOld ? 'Increased' : (maxPleasureCalibration < maxPleasureCalibrationOld ? 'Decreased' : 'Unchanged');
        const painDiff = maxPainCalibration > maxPainCalibrationOld ? 'Increased' : (maxPainCalibration < maxPainCalibrationOld ? 'Decreased' : 'Unchanged');

        const telemetry = `The user completed the calibration.". Telemetry data (Old -> New limits): ` +
            `Min Threshold: ${minCalibrationOld} -> ${minCalibration} (${minDiff}), ` +
            `Max Pleasure: ${maxPleasureCalibrationOld} -> ${maxPleasureCalibration} (${pleasureDiff}), ` +
            `Max Pain: ${maxPainCalibrationOld} -> ${maxPainCalibration} (${painDiff}). ` +
            `Acknowledge these specific limit changes in your narration. React to the user's courage or hesitation!`;

        restrRemoteState.telemetryQueue.push(telemetry);
        toastr.success("Calibration saved.");
    });
}



/**
 * Registers UI elements for managing the active profiles.
 * This allows users to easily switch between different sets
 * of sensations based on the current story context or
 * their personal preferences.
 */
async function registerUiProfiles() {

    // --- Populate checkbox list ---
    const $profileList = $('#estim_profile_list');
    $profileList.empty(); // Remove the "Loading profiles..." text

    const activeIds = getSettings().lastActiveProfiles || [];

    // Generate for each profile a checkbox. If the profile is active, the checkbox is checked.
    // Omit the system profiles (isSystem==true) from the list, as they cannot be activated or deactivated by the user.
    Object.entries(profilesState.profiles).forEach(([id, data]) => {
        if (data.isSystem) return; // Skip system profiles

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

    // Event listener for clicks on the checkboxes
    $profileList.on('change', '.estim-profile-checkbox', async function () {
        const profileId = $(this).val();
        const isSelected = $(this).is(':checked');

        if (isSelected) {
            await activateProfile(profileId, false);
        } else {
            await deactivateProfile(profileId, false);
        }
    });
}


/**
 * Registers UI input fields for customizing the
 * channel names. This allows users to personalize
 * the names of the stimulated body parts in the
 * profile descriptions and macros.
 */
async function registerUiChannelNames() {
    const settings = getSettings();

    // Map channel input names to settings and update AI tools on change
    $('#estim_ch1_input').val(settings.channel1).on('change', async function () {
        settings.channel1 = $(this).val();
        await updateSettings(); // Persist settings and update AI tools
    });
    $('#estim_ch2_input').val(settings.channel2).on('change', async function () {
        settings.channel2 = $(this).val();
        await updateSettings(); // Persist settings and update AI tools
    });
}


/**
 * Registers a checkbox in the UI to allow users to hide or show
 * the toast notifications when a sensation is played. This gives users
 * the option to reduce on-screen distractions and maintain immersion,
 * especially during intense story moments when they may want to focus
 * solely on the narrative and their physical sensations.
 */
async function registerUiBlindfoldMode() {
    const settings = getSettings();
    const $toastCheckbox = $('#estim_hide_toasts_checkbox');

    // Sets the checkbox based on the saved setting (default: unchecked, meaning toasts are shown)
    $toastCheckbox.prop('checked', settings.blindfoldModes);

    // Event listener for checkbox changes
    $toastCheckbox.on('change', async function () {
        settings.blindfoldModes = $(this).is(':checked');
        await updateSettings();
    });
}


/**
 * Registers a checkbox in the UI to allow users to enable or
 * disable "Simulation Only" mode. When enabled, this mode prevents
 * any actual sensations from being sent to the user's device, allowing
 * for safe testing or demonstration of the system without physical
 * stimulation. This is particularly useful for developers, testers,
 * or users who want to preview the functionality without engaging
 * in real sensations.
 */
async function registerUiSimulationOnly() {
    const settings = getSettings();
    const $simulationCheckbox = $('#estim_simulation_only_checkbox');

    // Sets the checkbox based on the saved setting (default: unchecked, meaning sensations are output)
    $simulationCheckbox.prop('checked', settings.simulationOnly);

    // Event listener for checkbox changes
    $simulationCheckbox.on('change', async function () {
        settings.simulationOnly = $(this).is(':checked');

        if (settings.simulationOnly) {
            // Stop all stimulation if we are switching to simulation-only mode to prevent any real sensations from being sent.
            stopAllEstimSignals();
        }

        await updateSettings();
    });
}


/**
* Registers a "Stretch Factor" input in the UI to allow
* users to adjust the duration stretch factor for sensations.
*/
async function registerUiStretchFactor() {
    const settings = getSettings();

    $('#estim_stretch_factor_input').val(settings.durationStretchFactor).on('change', async function () {
        // Forces the input to be a float (fallback 1.5 if invalid input is given)
        settings.durationStretchFactor = parseFloat($(this).val()) || 1.5;
        await updateSettings();
    });
}


/**
 * Registers a "Stop" button in the UI to allow
 * users to immediately stop all active sensations.
 */
async function registerUiStopButton() {
    const buttonHtml = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'button');
    const getWandContainer = () => $(document.getElementById('estim_wand_container') ??
        document.getElementById('extensionsMenu'));

    getWandContainer().append(buttonHtml);

    // Add stop button action
    $('#estim_stop').on('click', (e) => {
        e.preventDefault();
        stopAllEstimSignals();
    });
}


/**
 * Updates the Calibration Studio dropdown list.
 * Appends the calibration multiplier to the pattern name only if
 * a custom user override is set, keeping the UI clean and native.
 */
function updateCalibrationDropdownUI() {
    const $calibSelect = $('#estim_calib_pattern');
    if (!$calibSelect.length) return;

    // Remember the currently selected value
    const currentVal = $calibSelect.val();

    // Clear the dropdown
    $calibSelect.empty().append('<option value="">Select a pattern to calibrate...</option>');

    const settings = getSettings();

    profilesState.patternNames.forEach(pat => {
        const isCustom = settings.customCalibrations[pat] !== undefined;

        if (isCustom) {
            // Custom value -> Append the multiplier to highlight the modification
            const currentCal = settings.customCalibrations[pat];
            $calibSelect.append(`<option value="${pat}" class="estim-calib-custom">${pat} (${currentCal.toFixed(1)}x)</option>`);
        } else {
            // Default value -> Keep the list clean and untouched
            $calibSelect.append(`<option value="${pat}" class="estim-calib-default">${pat}</option>`);
        }
    });

    // Restore the previous selection if it still exists
    if (profilesState.patternNames.includes(currentVal)) {
        $calibSelect.val(currentVal);
    }
}

/**
 * Builds and registers the UI for calibrating the intensity of
 * the sensations. This allows users to adjust the strength of each pattern.
 */
async function registerUiCalibrationStudio() {
    const settings = getSettings();

    // If a pattern is selected in the dropdown: Load its value into the slider
    $('#estim_calib_pattern').on('change', function () {
        const pat = $(this).val();
        if (!pat) return;

        const [prof, name] = pat.split('/');
        const sensation = profilesState.profiles[prof]?.sensations?.find(s => s.name === name);
        const baseCal = sensation?.calibration || 1.0;
        const currentCal = settings.customCalibrations[pat] !== undefined ? settings.customCalibrations[pat] : baseCal;

        $('#estim_calib_slider').val(currentCal);
        $('#estim_calib_value').text(currentCal.toFixed(1) + 'x');
    });

    // If the slider is moved: Update the text next to it
    $('#estim_calib_slider').on('input', function () {
        $('#estim_calib_value').text(parseFloat($(this).val()).toFixed(1) + 'x');
    });

    // Test-Button (Plays the signal for 3 seconds at level 50 with the slider factor)
    $('#estim_calib_test').on('click', async function () {
        const pat = $('#estim_calib_pattern').val();
        if (!pat) return toastr.warning("Select a pattern first!");

        const testCal = parseFloat($('#estim_calib_slider').val());
        // Use the 6th parameter (overrideCalibration)
        await playEstimSignal(pat, 50, 3, 'both', false, testCal);
    });

    // Save button
    $('#estim_calib_save').on('click', async function () {
        const pat = $('#estim_calib_pattern').val();
        if (!pat) return toastr.warning("Select a pattern first!");

        settings.customCalibrations[pat] = parseFloat($('#estim_calib_slider').val());
        await updateSettings();
        updateCalibrationDropdownUI();
        toastr.success(`Saved calibration for ${pat}`);
    });

    // Reset button (Deletes the custom calibration and falls back to the JSON/1.0 default)
    $('#estim_calib_reset').on('click', async function () {
        const pat = $('#estim_calib_pattern').val();
        if (!pat) return;

        delete settings.customCalibrations[pat];
        await updateSettings();
        updateCalibrationDropdownUI();
        $('#estim_calib_pattern').trigger('change'); // Update UI
        toastr.info("Calibration reset to defaults.");
    });

    // At this point, the HTML is injected and the profiles are loaded.
    // We populate the dropdown for the very first time.
    updateCalibrationDropdownUI();
}


/**
 * Registers custom macros for this extension. This allows users
 * to use placeholders in their profile descriptions
 */
async function registerUiMacros() {
    // Register global macros for channel names so they can be used in the profile descriptions.
    const { macros } = SillyTavern.getContext();
    if (!macros || typeof macros.register !== 'function') return;

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
            return getAudioStateString();
        }
    });

    if (DEBUG_MODE) console.log('ESTIM: Custom macros {{estim_ch1}}, {{estim_ch2}} and {{estim_patterns}} registered globally.');
}


// ==== EXTENSION LIFECYCLE METHODS ====


globalThis.estimPromptInterceptor = async function (chat, contextSize, abort, type) {
    console.log('ESTIM: Prompt interceptor called. Current chat:', chat, contextSize, type);

    // No background tasks
    if (type === 'quiet') {
        return; // Early Return für Hintergrund-Generierungen
    }

    // Fetch the normal hardware status string
    let telemetryString = getAudioStateString();

    // Check if the user ignored a pending trick challenge and add telemetry if so.
    // This allows the LLM to react to the user's choice of ignoring the challenge,
    // which can be just as narratively interesting as accepting it. By
    // acknowledging the user's decision to avoid the secret button,
    // the LLM can adapt the story accordingly, perhaps by describing the character's
    // cautious behavior or missed opportunities for unexpected sensations.
    // This adds depth and responsiveness to the narrative, making the user's
    // choices feel meaningful even when they opt for safety.
    if (restrRemoteState.remoteControlConfig?.trick_or_treat_module?.enabled) {
        restrRemoteState.telemetryQueue.push(
            `The user was too scared to press your secret button and completely ignored your challenge! React to their cowardice.`
        );

        // Hide the Trick-or-Treat button and clean UI
        remoteControlConfig.trick_or_treat_module.enabled = false;
        configureRemoteControlWidget();
    }

    // Show current remote control config in the telemetry if it is open.
    if (restrRemoteState.isOpen && restrRemoteState.remoteControlConfig) {
        telemetryString += ` | VISIBLE UI (remoteControlConfig): ` + JSON.stringify(restrRemoteState.remoteControlConfig);
    }

    // Add remote control events, if any
    if (restrRemoteState.telemetryQueue.length > 0) {
        telemetryString += ` | RESTRICTED REMOTE CONTROL EVENTS: ` + restrRemoteState.telemetryQueue.join(' ');
        restrRemoteState.telemetryQueue = []; // Clear the queue after reading
    }

    const systemNote = {
        name: "Hardware State",
        is_system: true,
        send_date: Date.now(),
        content: `[REAL-TIME HARDWARE STATE: The e-stim device on {{user}} reports the following telemetry: ` +
            telemetryString + `]\n\n` +
            `SYSTEM INSTRUCTION: Acknowledge this physical reality in your narrative. If your last action ` +
            `has finished naturally, narrate the aftermath. If a sensation is currently running, actively ` +
            `decide whether to maintain, change, or stop it using the 'inflict_physical_sensation' tool.]`
    };

    // Insert before the last message
    chat.splice(chat.length - 1, 0, systemNote);
};


/**
 * This function is called by SillyTavern when the extension is activated.
 * It registers all the necessary components of the extension, such as function tools,
 * slash commands, and UI elements.
 */
export async function onActivate() {
    await initAudioContext();
    await loadProfiles();
    await setupAutoAudioUnlock();
    await registerUiElements();
    await registerCommand();

    // Async! Activate all system profiles, as they are not defined in the settings
    // but should always be active. We load the background profiles first to ensure
    // they are active before any user interaction
    onActivateBackgroundLoad();
}

/**
 * This function loads all audio tracks
 */
async function onActivateBackgroundLoad() {
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
}

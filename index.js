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
 * @version 1.5.0
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
let estimAvailableStimulations = {};
let estimAudioBuffers = {};
let estimAudioBuffersCanLoop = [];
let estimAudioContext = null;
let estimActiveSources = [];
let generationEndedHandler = null;
let audioTimerId = null;

// Profile Management State
let estimProfiles = {};         // Map of filename -> profile data
let activeProfile = {
    id: '',                 // The filename of the currently active profile
    patternDescriptions: '', // The AI-facing descriptions of the patterns based on the active profile
    patternNames: []     // The list of pattern names available in the active profile
};

// Scheduled stimulation parameters that will be applied when
//  the next generation finishes. This allows the AI to set 
// the desired stimulation parameters during generation, and 
// then have them executed at the right moment after the 
// message is rendered.
let scheduledEstim = {
    pending: false,
    playing: false,
    painEnabled: false,
    pattern: '',
    intensity: 10,
    duration: 0,
    startTime: 0
};

// ==== SETTINGS MANAGEMENT ====

// Define default settings
const defaultSettings = Object.freeze({
    lastActiveProfile: '', // Remembers the last selected profile
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
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
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

    // Refresh the AI tools so the LLM gets the new sensation descriptions
    await registerAiFunctionTools();
    await registerCommand();

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
        const indexResp = await fetch(new URL(configFile, baseUrl).href);
        if (!indexResp.ok) return; // Silently skip if config (like user config) doesn't exist

        const profileFiles = await indexResp.json();

        for (const fileName of profileFiles) {
            try {
                const profileResp = await fetch(new URL(fileName, baseUrl).href);
                if (profileResp.ok) {
                    const profileData = await profileResp.json();

                    // Get the profile name. Preferably it is the 'name' attribute
                    // If it is not found, use the filename
                    const id = profileData.name || fileName;

                    // Store profile with name or fileName as unique ID
                    estimProfiles[id] = profileData;
                    estimProfiles[id].id = id;

                    // Add stop pattern description to the profile's sensations for AI tool context
                    estimProfiles[id].sensations.stop = 'Stop all signals immediately.';

                    if (DEBUG_MODE) {
                        console.log(`ESTIM: Profile "${profileData.display_name}" loaded from ${fileName}`,
                            estimProfiles[id]);
                    }
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
 * Each profile contains a display_name and mapping of patterns to sensations.
 */
async function loadProfiles() {
    estimProfiles = {};
    await loadProfileDirectory(PATH_PROFILES_DEFAULT, FILE_CONFIG_PROFILES);
    await loadProfileDirectory(PATH_PROFILES_LOCAL, FILE_CONFIG_PROFILES);
}


/**
 * Switches the active device configuration and refreshes the AI tools.
 */
async function switchProfile(profileId, quiet = false) {

    // Validate profile ID and existence
    const profile = estimProfiles[profileId] || {};
    if (!profile) {
        console.error(`ESTIM: Profile ${profileId} not found.`);
        return false;
    }

    // Set active profile and persist in settings
    const settings = getSettings();
    activeProfile.id = profileId;
    settings.lastActiveProfile = profileId;

    // Get current channel names with fallback to defaults if not set. These will be used to 
    // replace the placeholders in the profile descriptions.
    const ch1_text = settings.channel1 || DEFAULT_CHANNEL_1_NAME;
    const ch2_text = settings.channel2 || DEFAULT_CHANNEL_2_NAME;

    // Get sensations from active profile and filter to only include those that 
    // have a corresponding audio pattern loaded in estimAvailableStimulations. 
    // This ensures that the AI tool descriptions only include patterns that can 
    // actually be played.
    const sensations = Object.fromEntries(
        Object.entries(profile.sensations || {}).filter(([name]) => name in estimAvailableStimulations)
    );

    if (DEBUG_MODE) console.log('ESTIM: Active patterns after profile filtering:', sensations);

    // Describe patterns based on active profile's subjective descriptions
    // The placeholders {{estim_ch1}} and {{estim_ch2}} can be used in the 
    // profile to refer to the AI-customizable channel names, which are replaced here.
    activeProfile.patternDescriptions = Object.entries(sensations)
        .map(([name, rawDesc]) => {
            // Replace {{CH1}} and {{CH2}} (Case-Insensitive)
            let parsedDesc = rawDesc
                .replace(/\{\{estim_ch1\}\}/gi, ch1_text)
                .replace(/\{\{estim_ch2\}\}/gi, ch2_text);

            // Get the associated audio buffer
            const buffer = estimAudioBuffers[name];
            if (buffer) {
                parsedDesc = `${parsedDesc} (duration: ${buffer.duration.toFixed(1)} s`;

                if (estimAudioBuffersCanLoop[name] || false) {
                    parsedDesc = `${parsedDesc}, can loop`;
                }
                parsedDesc = `${parsedDesc})`;

            }

            // Return entire description
            return `  - "${name}": ${parsedDesc}`;
        })
        .join('\n');

    // Update the array of available pattern names for the UI and AI tool
    activeProfile.patternNames = Object.keys(sensations);
    if (DEBUG_MODE) console.log('ESTIM: Active patterns:', activeProfile.patternNames);

    // Update UI Dropdown if it exists
    $('#estim_profile_select').val(profileId);

    // Stores the settings and updates the strings
    await updateSettings();

    if (!quiet) {
        toastr.info(`Estim Profile: ${estimProfiles[profileId].display_name}`, 'ESTIM');
    }
    if (DEBUG_MODE) console.log(`ESTIM: Switched to profile "${estimProfiles[profileId].display_name}"`);
    return true;
}


// ==== ESTIM FILE LOADING ====


/**
 * Helper function to sequentially load a directory and overload the global configuration.
 * This reads the JSON config from a specific folder, downloads the defined audio files, 
 * and stores them in the global estimAvailableStimulations dictionary.
 * @param {string} folderPath The relative path to the folder (e.g. './audio/')
 * @param {string} configFile The name of the json file inside that folder
 */
async function loadEstimDirectory(folderPath, configFile) {
    const baseUrl = new URL(folderPath, import.meta.url).href;

    if (DEBUG_MODE) console.log(`ESTIM: Processing config from ${folderPath}${configFile}`);

    try {
        const resp = await fetch(new URL(configFile, baseUrl).href);
        if (!resp.ok) return; // Silently skip if config (like user config) doesn't exist

        const data = await resp.json();
        if (!data.estims) return;

        for (const stim of data.estims) {
            // Check if user disabled/deleted this pattern explicitly
            if (stim.disabled === true) {
                delete estimAvailableStimulations[stim.name];
                delete estimAudioBuffers[stim.name];
                delete estimAudioBuffersCanLoop[stim.name];
                if (DEBUG_MODE) console.log(`ESTIM: Pattern "${stim.name}" explicitly removed by config.`);
                continue;
            }
            if (stim.name && stim.file) {
                try {
                    // Fetch and decode audio file relative to its config folder
                    const audioUrl = new URL(stim.file, baseUrl).href;
                    const audioResp = await fetch(audioUrl);
                    if (!audioResp.ok) throw new Error(`HTTP ${audioResp.status}`);

                    const arrayBuffer = await audioResp.arrayBuffer();
                    const audioBuffer = await estimAudioContext.decodeAudioData(arrayBuffer);

                    // Overwrite or create new entry in the global state
                    estimAvailableStimulations[stim.name] = stim;
                    estimAudioBuffers[stim.name] = audioBuffer;
                    estimAudioBuffersCanLoop[stim.name] = stim.can_loop || false;

                    if (DEBUG_MODE) console.log(`ESTIM: Loaded pattern "${stim.name}" from ${stim.file}`);
                } catch (e) {
                    console.error(`ESTIM: Failed to load ${stim.file}`, e);
                }
            }
        }

        if (DEBUG_MODE) console.log(`ESTIM: Successfully processed config from ${folderPath}${configFile}`);

    } catch (e) {
        // Log purely for debugging purposes (e.g. if the JSON is malformed)
        if (DEBUG_MODE) console.log(`ESTIM: Config ${folderPath}${configFile} skipped.`);
    }
}


/**
 * Registers the available estim patterns by loading the default and user configurations,
 * and preloading the corresponding audio files into memory. This should be called once 
 * during initialization to set up the global state for available stimulations.
 */
async function registerEstimFiles() {
    estimAudioBuffers = {};
    estimAudioBuffersCanLoop = [];

    // Add static stimulation patterns here. Actually right now this
    // is only the 'stop' command, which is not associated with an audio file but is recognized in the logic.
    estimAvailableStimulations = {
        'stop': {
            name: 'stop',
            file: null
        }
    };

    // 1. Load the default configuration provided by the extension
    await loadEstimDirectory(PATH_AUDIO_DEFAULT, FILE_CONFIG_STIMS);

    // 2. Load the user configuration, which will overload/overwrite the default settings
    // This folder is safely ignored by git (.gitignore) to keep user files private.
    await loadEstimDirectory(PATH_AUDIO_LOCAL, FILE_CONFIG_STIMS);

    // Calculate memory usage (Float32 PCM = 4 bytes per sample per channel)
    let totalMemoryBytes = 0;
    for (const buffer of Object.values(estimAudioBuffers)) {
        totalMemoryBytes += buffer.length * buffer.numberOfChannels * 4;
    }

    if (DEBUG_MODE) {
        const totalMB = (totalMemoryBytes / (1024 * 1024)).toFixed(2);
        console.log(`ESTIM: 🎵 Loaded ${Object.keys(estimAvailableStimulations).length} estim patterns — Total preloaded memory: ${totalMB} MB`);
    }
}


// ==== AUDIO CORE ====


/**
 * Plays the audio signal corresponding to the given estim pattern, intensity and duration. This is called after 
 * the next message is fully rendered, allowing the user to receive the stimulation at the right moment in the narrative.
 * 
 * @param {string} pattern The name of the estim pattern to use (e.g. "tickle", "push", "cramp", "shock")
 * @param {string|number} intensity The intensity of the signal, from "1" to "100" for pleasurable intensities and "101" to "200" for pain intensities. Default is "10". "0" stops the signal immediately.
 * @param {string|number} duration The duration of the signal in seconds. Default is "0" which plays the file once. -1 means looping
 * @param {boolean} quiet Suppress chat output
 * @returns 
 */
async function playEstimSignal(pattern, intensity = 10, duration = 0, quiet = false) {
    const stim = estimAvailableStimulations[pattern];
    const buffer = estimAudioBuffers[pattern];

    // Stop stimulation? If intensity is 0, we interpret this as a command to stop the signal immediately without starting a new one.
    if (intensity === 0 || pattern.toLowerCase() === 'stop') {
        stopAllEstimSignals();
        return true;
    }

    if (!stim || !buffer) {
        console.error(`ESTIM: Pattern "${pattern}" not found`);
        if (!quiet) {
            SillyTavern.getContext().sendSystemMessage('generic', `Unknown estim pattern "${pattern}"`, { isSmallSys: true });
        }
        return false;
    }

    // Ensure the AudioContext is resumed in response to a user gesture, if it is currently suspended. 
    // This is necessary because many browsers require a user interaction before allowing audio playback.
    await ensureAudioContext();
    if (!estimAudioContext) {
        return; // Failsafe if hardware unsupported
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

    const now = estimAudioContext.currentTime;
    const fadeInTime = 0.012;   // 12 ms fade-in — this kills the plop

    // Create nodes
    const source = estimAudioContext.createBufferSource();
    source.buffer = buffer;

    // Create listener to clean up when the playback ends
    source.onended = () => {
        if (DEBUG_MODE) console.log(`ESTIM: Stop event called`);
        scheduledEstim.playing = false;

        // Terminate running audio termination timer if there still exists one
        if (audioTimerId) {
            clearTimeout(audioTimerId);
            audioTimerId = null;
        }
    };

    const gain = estimAudioContext.createGain();
    gain.gain.setValueAtTime(0.001, now);  // start almost silent

    source.connect(gain);
    gain.connect(estimAudioContext.destination);

    // Start playback
    source.start(now);

    // Smooth exponential ramp up (sounds natural)
    gain.gain.exponentialRampToValueAtTime(targetVolume, now + fadeInTime);

    // Set audio cancel timer if a specific duration was set
    if (duration > 0) {
        // Set looping to repeat the audio in case the duration
        // is set longer than the duration of the file
        source.loop = true;

        // Start timer
        audioTimerId = setTimeout(() => {
            audioTimerId = null; // Remove reference to this timeout
            stopAllEstimSignals(15);
        }, duration * 1000);
    }
    if (duration < 0) {
        // A negative value indicates that the playback shall continue
        // until a new command is issued. Only do this if it is allowed
        if (estimAudioBuffersCanLoop[pattern] || false) {

            // Set looping 
            source.loop = true;
        } 
        else {
            // No looping allowed. Set to single playback
            duration = 0;
            console.warn(`ESTIM: Continuous playback of non-loopable sensation ${pattern} prevented`);
        }
    }
    if (duration === 0) { 
        // Play the file exactly one time and then stops
        source.loop = false;

        // TODO Register a listener when the audio playback ended
    }

    // Remember everything
    scheduledEstim.startTime = now;
    scheduledEstim.playing = true;

    // Track for later stopping
    estimActiveSources.push({ source, gain });

    // Console + system message
    if (DEBUG_MODE) console.log(`ESTIM: 🎵 Playing ${stim.file} | intensity ${intensity}% | fade-in 12ms`);
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

    // Nothing to do?
    if (estimActiveSources.length === 0 || !estimAudioContext) return;

    const now = estimAudioContext.currentTime;
    estimActiveSources.forEach(({ source, gain }) => {
        try {
            gain.gain.cancelScheduledValues(now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + fadeOutMs / 1000);
            source.stop(now + fadeOutMs / 1000 + 0.01);
        } catch (e) { }
    });

    estimActiveSources = [];

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
    if (estimAudioContext) return estimAudioContext;

    try {
        estimAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (DEBUG_MODE) console.log('ESTIM: Web AudioContext initialized');
        return estimAudioContext;
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
    if (estimAudioContext?.state === 'suspended') {
        await estimAudioContext.resume();
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
        const { registerFunctionTool,
            unregisterFunctionTool,
            isToolCallingSupported,
            eventSource,
            event_types } = SillyTavern.getContext();

        // Unregister first to avoid duplicates during development
        unregisterFunctionTool('inflict_physical_sensation');
        unregisterFunctionTool('estim_set_profile');

        if (!isToolCallingSupported()) {
            console.warn('ESTIM: Function calling is not supported by your current API.');
            return;
        }

        if (activeProfile.patternNames.length === 0) {
            console.warn('ESTIM: No patterns loaded. Skipping AI tool registration.');
            return;
        }

        const estimSchema = {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    enum: activeProfile.patternNames,
                    description: `The sensation pattern to inflict on the user. If a sensation is painful due to its shape, ' +
                        'it is also indicated in the following description. Current available sensations:\n' +
                        '${activeProfile.patternDescriptions}`
                },
                intensity: {
                    type: 'integer',
                    description: 'Intensity 1-100 (pleasure intensity), 101-200 (pain intensity). Every sensation ' +
                        'can be made painful by increasing its intensity to pain intensity. This means that normal ' +
                        'pleasure sensations will become pain sensations at intensities greater 100, whereas ' +
                        'pain sensations will always be painfull regardless of a certain intensity threshold. ' +
                        'To unlock painful intensities, "is_pain_intensity" must be set to true as a safety measure. ' +
                        'Default is 10 (low intensity). The intensity is a multiplier to the intensity indication ' +
                        'in the description. ',
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
                        'Examples: 30 words ≈ 12 s, 60 words ≈ 24 s, 90 words ≈ 36 s, 150 words ≈ 60 s.\n' +
                        'Exceptions:\n' +
                        '- For sensations intended to persist across multiple turns or scenes, use a ' +
                        'negative value (continuous loop).\n' +
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
                'match the story\'s physical sensations. Each description specifies the default duration of ' +
                'the sensation for one iteration. If looping is allowed is indicated in the pattern description. ' +
                'IMPORTANT: You must generate the story text and call the tool in the same response. Do ' +
                'not stop generating text after calling this tool!',
            parameters: estimSchema,
            stealth: false,
            action: async (args) => {

                // --- QUICK WIN: Failsafe gegen den ST-Backend Crash (OpenRouter Caching) ---
                const context = SillyTavern.getContext();
                if (context.chat && context.chat.length > 0) {
                    // Wir prüfen die letzten 3 Nachrichten sicherheitshalber durch
                    const startIndex = Math.max(0, context.chat.length - 3);
                    let chatRepaired = false;

                    for (let i = startIndex; i < context.chat.length; i++) {
                        if (typeof context.chat[i].mes === 'undefined' || context.chat[i].mes === null) {
                            context.chat[i].mes = '';
                            chatRepaired = true;
                            if (DEBUG_MODE) console.warn(`ESTIM: Repaired empty message at index ${i} to prevent caching crash.`);
                        }
                    }

                    // Zwingt das Frontend, die reparierte Historie JETZT ins Backend zu spiegeln
                    if (chatRepaired && typeof context.saveChat === 'function') {
                        await context.saveChat();
                        if (DEBUG_MODE) console.log('ESTIM: Forced backend sync for repaired chat.');
                    }
                }
                // -----------------------------------------------------------------------------

                // Recognize special "stop" command: If intensity is 0 or pattern name is "stop", 
                // we interpret this as a command to stop the signal immediately without starting a new one. 
                if (args.intensity === 0 || args.pattern.toLowerCase() === 'stop') {
                    stopAllEstimSignals();
                    return 'Stopped all e-stim signals.';
                }

                if (!args?.pattern) {
                    return `Missing required parameter "pattern". Please specify which estim pattern ` +
                        `to play based on the narrative context. Available patterns:\n${activeProfile.patternDescriptions}`;
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
                scheduledEstim.painEnabled = pain_enabled;
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
                return success ? `Switched to profile ${estimProfiles[args.profile_name].display_name}` : "Profile not found.";
            }
        }); */

        // Register a listener that will fire when the FULL AI generation is finished
        // (including thinking mode / multi-message responses). This guarantees the
        // estim signal only plays after ALL messages are visible on screen.
        if (generationEndedHandler) {
            eventSource.removeListener(event_types.GENERATION_ENDED, generationEndedHandler);
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
                enumList: activeProfile.patternNames,
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
        callback: (args) => switchProfile(args.unnamed),
        helpString: 'Switch the active estim profile by filename.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Profile filename',
                isRequired: true
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

    // Populate profile switcher dropdown
    const $select = $('#estim_profile_select');
    $select.empty();
    Object.entries(estimProfiles).forEach(([id, data]) => {
        $select.append(`<option value="${id}">${data.display_name} (by ${data.author || 'Unknown'})</option>`);
    });
    $select.val(activeProfile.id);
    $select.on('change', () => switchProfile($select.val()));

    // Map channel input names to settings and update AI tools on change
    const settings = getSettings();
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
            handler: () => activeProfile.patternDescriptions
        });

        // Pattern-Makro: Generiert eine formatierte Liste aller Patterns des aktuellen Profils
        macros.register('estim_state', {
            description: 'Returns the E-stim state at start of a turn. Inject into prompt.',
            handler: () => {
                if (!scheduledEstim.playing) {
                    return "no sensation inflicted";
                }

                // Calculate elapsed time
                const elapsedTime = estimAudioContext.currentTime - scheduledEstim.startTime;

                let state = `pattern: \"${scheduledEstim.pattern}\", intensity: ${scheduledEstim.intensity}, ` +
                    `is_pain_enabled: ${scheduledEstim.painEnabled}, elapsed_time: ${elapsedTime} s`;

                if (scheduledEstim.duration > 0) {
                    state = `${state}, total_duration: ${scheduledEstim.duration} s`
                }
                if (scheduledEstim.duration < 0) {
                    state = `${state}, runs continously`
                }
                if (scheduledEstim.duration === 0) {
                    // Not implemented yet
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
    await registerEstimFiles();
    await loadProfiles();
    setupAutoAudioUnlock();

    // Determine initial profile
    const settings = getSettings();
    const available = Object.keys(estimProfiles);
    const initial = (available.includes(settings.lastActiveProfile)) ? settings.lastActiveProfile : available[0];

    if (initial) await switchProfile(initial, true);

    await registerUiElements();
}
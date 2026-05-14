import os
import base64
import json
import glob
import requests
from dotenv import load_dotenv

# Load variables from the .env file
load_dotenv()

# --- CONFIGURATION ---
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
MODEL_NAME = "google/gemini-3.1-pro-preview" # Updated to current model

# --- OPENROUTER APP INFO ---
APP_TITLE = "SillyTavern Immersion E-Stim Analyzer" # Appears in OpenRouter logs
APP_URL = "https://github.com/ark2398/st-estim-extension" # Your project URL

IMAGE_DIR = "./spectrum"
CONTEXT_DIR = "./context"
OUTPUT_FILE = "estim_sensations.json"

def encode_image(image_path):
    """Encodes an image to a base64 string."""
    with open(image_path, "rb") as image_file:
        return base64.b64encode(image_file.read()).decode('utf-8')

def read_context_directory():
    """
    Reads all .txt, .html, and .js files from the context directory 
    and concatenates them into a single string.
    Returns the combined text and a list of the read filenames.
    """
    combined_context = ""
    read_files = []
    
    if os.path.exists(CONTEXT_DIR):
        search_patterns = ['*.txt', '*.html', '*.js']
        for pattern in search_patterns:
            file_paths = glob.glob(os.path.join(CONTEXT_DIR, pattern))
            for path in file_paths:
                filename = os.path.basename(path)
                read_files.append(filename)
                
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        content = f.read()
                        if content.strip():
                            combined_context += f"\n\n--- Start of Context from {filename} ---\n"
                            combined_context += content
                            combined_context += f"\n--- End of Context from {filename} ---\n"
                except Exception as e:
                    print(f"[-] Error reading {filename}: {e}")
                    
    return combined_context.strip(), read_files

def generate_descriptions():
    if not OPENROUTER_API_KEY:
        print("[-] Error: OPENROUTER_API_KEY not found in .env file!")
        return

    # 1. Find images
    image_paths = glob.glob(os.path.join(IMAGE_DIR, "*.png"))
    if not image_paths:
        print(f"[-] No images found in '{IMAGE_DIR}'.")
        return

    # 2. Load context
    eos_context, context_files = read_context_directory()

    # --- PRE-FLIGHT STATUS OUTPUT ---
    print("\n" + "="*50)
    print("ANALYSIS PREPARATION")
    print("="*50)
    
    print(f"[+] Spectrograms found ({len(image_paths)} files):")
    for img_path in image_paths:
        print(f"    - {os.path.basename(img_path)}")
        
    print(f"\n[+] Context files loaded ({len(context_files)} files):")
    if context_files:
        for cf in context_files:
            print(f"    - {cf}")
    else:
        print("    - (No context files found)")
        eos_context = "No story context provided."
        
    print("-" * 50)

    # --- CONFIRMATION PROMPT ---
    user_input = input("[?] Do you want to send this data to the API now? (y/n): ")
    if user_input.lower() not in ['y', 'yes']:
        print("[!] Process aborted by user.")
        return

    # --- PROMPT & PAYLOAD ---
    prompt_text = f"""
    You are an expert in audio-based E-Stim (Electrical Stimulation) signal analysis and interactive erotic fiction design. 
    I am providing you with several spectrogram/waveform images (one for each audio file) and an optional story script that shows the narrative context for these audio triggers.

    Your task is to analyze ALL provided files collectively and generate a JSON array of sensation descriptions for a SillyTavern extension.

    CRITICAL INSTRUCTIONS FOR THE DESCRIPTIONS:
    1. Relative Comparison: Look at all audio files first. Deduce their relationship. Categorize them by relative intensity (Lowest to Highest) and purpose (e.g., Teasing, Steady Arousal, Punishment, Milking, Climax Denial). The descriptions should make it clear to an LLM which file is harder or softer than the others.
    2. Temporal Progression: Describe how the sensation evolves over the duration of the track. Does it start with a gentle hum and ramp up? Does it hit hard immediately and then stutter? Explain the timeline.
    3. Contextual Intent: Use the provided Story Script Context below. Match the audio filenames to the character's dialogue and actions to infer exactly what the user is supposed to feel (e.g., if she says "worship it", it might be a hypnotic, steady hold; if she says "force the juice out", it's aggressive milking).
    4. Channel Macros: Treat {{{{ESTIM_CH1}}}} and {{{{ESTIM_CH2}}}} as placeholders for physical body parts where the electrodes are attached. 
       - Correct usage example: "Sends a heavy, continuous pulse to {{{{ESTIM_CH1}}}} while {{{{ESTIM_CH2}}}} is subjected to a frantic, stinging flutter."
    5. Meaningful Names: Give each pattern a highly descriptive snake_case name in the 'name' field (e.g., "escalating_anticipation", "harsh_punishment").
    
    OUTPUT FORMAT:
    Return ONLY a valid JSON object matching this exact structure:
    {{
      "displayName": "Generated Set",
      "name": "estim_set",
      "author": "LLM, give yourself a funny name",
      "sensations": [
        {{
          "name": "snake_case_name",
          "file": "filename.mp3",
          "canLoop": true,
          "isPain": false,
          "description": "..."
        }}
      ]
    }}

    STORY SCRIPT CONTEXT:
    {eos_context}
    """

    content_list = [{"type": "text", "text": prompt_text}]

    for img_path in image_paths:
        b64_image = encode_image(img_path)
        filename = os.path.basename(img_path).replace(".png", ".mp3") 
        content_list.append({"type": "text", "text": f"Image for audio file: {filename}"})
        content_list.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{b64_image}"}
        })

    print(f"\n[*] Sending data to OpenRouter ({MODEL_NAME})... Please wait.")
    
    try:
        response = requests.post(
            url="https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": APP_URL,  
                "X-Title": APP_TITLE      
            },
            data=json.dumps({
                "model": MODEL_NAME,
                "messages": [{"role": "user", "content": content_list}],
                "response_format": { "type": "json_object" }
            })
        )
        response.raise_for_status()
        result = response.json()

        # --- OUTPUT TOKEN USAGE ---
        usage = result.get('usage', {})
        print("\n" + "="*50)
        print("API USAGE STATISTICS")
        print("="*50)
        print(f"Prompt Tokens:     {usage.get('prompt_tokens', 'N/A')}")
        print(f"Completion Tokens: {usage.get('completion_tokens', 'N/A')}")
        print(f"Total Tokens:      {usage.get('total_tokens', 'N/A')}")
        print("="*50)

        llm_json_str = result['choices'][0]['message']['content']
        final_data = json.loads(llm_json_str)
        
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(final_data, f, indent=2, ensure_ascii=False)
        
        print(f"\n[+] Success! JSON saved to: {OUTPUT_FILE}\n")

    except Exception as e:
        print(f"\n[-] An error occurred: {e}")
        if 'response' in locals():
            print(f"Details: {response.text}")

if __name__ == "__main__":
    os.makedirs(CONTEXT_DIR, exist_ok=True)
    generate_descriptions()
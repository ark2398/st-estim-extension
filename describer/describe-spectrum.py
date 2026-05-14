import os
import glob
import librosa
import librosa.display
import matplotlib.pyplot as plt
import numpy as np

def generate_estim_plots(input_dir, output_dir, file_pattern='*.mp3'):
    """
    Optimized for E-Stim Audio: Limits frequency range, adjusts contrast,
    and accurately maps the time axis.
    """
    
    os.makedirs(output_dir, exist_ok=True)
    search_pattern = os.path.join(input_dir, file_pattern)
    audio_files = glob.glob(search_pattern)
    
    if not audio_files:
        print(f"No audio files found matching '{file_pattern}' in directory '{input_dir}'.")
        return

    high_dpi = 300
    
    # --- E-STIM OPTIMIERUNGEN ---
    MAX_FREQ = 1500  # Schneidet alles über 1500 Hz ab
    MIN_DB = -50     # Ignoriert extrem leises Rauschen
    
    # Explizite Definition für die Fourier-Transformation, um Zeitachsen-Bugs zu vermeiden
    fft_window_size = 4096 
    hop_len = 512    
    
    for file_path in audio_files:
        filename = os.path.basename(file_path)
        filename_base = os.path.splitext(filename)[0]
        print(f"Processing E-Stim Analysis: {filename} ...")
        
        try:
            y, sr = librosa.load(file_path, sr=None, mono=False)
            is_stereo = (len(y.shape) > 1)
            
            num_rows = 4 if is_stereo else 2
            fig_height = 16 if is_stereo else 10
            fig, ax = plt.subplots(nrows=num_rows, sharex=True, figsize=(16, fig_height), layout="constrained")
            
            if is_stereo:
                # --- ROW 1: Left Channel Waveform ---
                librosa.display.waveshow(y[0], sr=sr, ax=ax[0], color="blue", alpha=0.7)
                ax[0].set(title=f'Left Channel AM (Envelope): {filename_base}', ylabel='Amplitude')
                
                # --- ROW 2: Left Channel Spectrogram ---
                D_L = librosa.stft(y[0], n_fft=fft_window_size, hop_length=hop_len)
                S_db_L = librosa.amplitude_to_db(np.abs(D_L), ref=np.max)
                
                # hop_length muss hier zwingend übergeben werden, sonst stimmt die x-Achse nicht!
                img_L = librosa.display.specshow(S_db_L, sr=sr, hop_length=hop_len, x_axis='time', y_axis='linear', ax=ax[1], cmap='magma', vmin=MIN_DB, vmax=0)
                ax[1].set_ylim([0, MAX_FREQ]) # Erzwingt den Zoom auf 0-1500 Hz
                ax[1].set(title='Left Channel Carrier Frequency (0 - 1.5 kHz)', ylabel='Frequency (Hz)')
                fig.colorbar(img_L, ax=ax[1], format="%+2.f dB")

                # --- ROW 3: Right Channel Waveform ---
                librosa.display.waveshow(y[1], sr=sr, ax=ax[2], color="red", alpha=0.7) 
                ax[2].set(title=f'Right Channel AM (Envelope): {filename_base}', ylabel='Amplitude')
                
                # --- ROW 4: Right Channel Spectrogram ---
                D_R = librosa.stft(y[1], n_fft=fft_window_size, hop_length=hop_len)
                S_db_R = librosa.amplitude_to_db(np.abs(D_R), ref=np.max)
                
                img_R = librosa.display.specshow(S_db_R, sr=sr, hop_length=hop_len, x_axis='time', y_axis='linear', ax=ax[3], cmap='magma', vmin=MIN_DB, vmax=0)
                ax[3].set_ylim([0, MAX_FREQ]) # Erzwingt den Zoom auf 0-1500 Hz
                ax[3].set(title='Right Channel Carrier Frequency (0 - 1.5 kHz)', ylabel='Frequency (Hz)')
                fig.colorbar(img_R, ax=ax[3], format="%+2.f dB")
                
            else:
                # Mono fallback
                librosa.display.waveshow(y, sr=sr, ax=ax[0], color="blue", alpha=0.7)
                ax[0].set(title=f'Mono AM (Envelope): {filename_base}', ylabel='Amplitude')
                
                D = librosa.stft(y, n_fft=fft_window_size, hop_length=hop_len)
                S_db = librosa.amplitude_to_db(np.abs(D), ref=np.max)
                
                img = librosa.display.specshow(S_db, sr=sr, hop_length=hop_len, x_axis='time', y_axis='linear', ax=ax[1], cmap='magma', vmin=MIN_DB, vmax=0)
                ax[1].set_ylim([0, MAX_FREQ]) 
                ax[1].set(title='Mono Carrier Frequency (0 - 1.5 kHz)', ylabel='Frequency (Hz)')
                fig.colorbar(img, ax=ax[1], format="%+2.f dB")

            fig.suptitle(f'E-Stim Audio Analysis: {filename}', fontsize=18, fontweight='bold')

            output_filename = f"{filename_base}.png"
            output_path = os.path.join(output_dir, output_filename)
            
            plt.savefig(output_path, dpi=high_dpi, bbox_inches='tight')
            plt.close(fig)
            print(f"-> Saved E-Stim plot as: {output_filename}")
            
        except Exception as e:
            print(f"Error processing {filename}: {e}")

# ==========================================
# Configuration: Directory paths
# ==========================================
if __name__ == "__main__":
    # Ordner auf Wunsch angepasst
    AUDIO_INPUT_DIR = "./audio" 
    AUDIO_OUTPUT_DIR = "./spectrum"
    
    if not os.path.exists(AUDIO_INPUT_DIR):
        print(f"Creating directory '{AUDIO_INPUT_DIR}'. Please place your MP3 files inside.")
        os.makedirs(AUDIO_INPUT_DIR)
        exit()
    
    print("Starting E-Stim optimized audio analysis...")
    generate_estim_plots(AUDIO_INPUT_DIR, AUDIO_OUTPUT_DIR, file_pattern='*.mp3')
    print("Done!")
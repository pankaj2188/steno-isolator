// UI Elements
const fileInput = document.getElementById('audio-upload');
const fileLabel = document.getElementById('file-label');
const progressWrapper = document.getElementById('progress-wrapper');
const progressFill = document.getElementById('progress-fill');
const statusText = document.getElementById('status-text');
const downloadBtn = document.getElementById('download-btn');

let downloadUrl = null;

// The RNNoise WASM module instance
let rnnoiseModule = null;

// Initialize RNNoise when the page loads
async function initRNNoise() {
    try {
        // The @ricky0123/rnnoise library exposes rnnoise as a global if loaded via script tag
        // We load the WASM module.
        rnnoiseModule = await rnnoise.load();
        console.log("RNNoise AI Model Loaded.");
    } catch (e) {
        console.error("Failed to load RNNoise:", e);
        statusText.innerText = "Error loading AI model. Check console.";
        statusText.style.color = "red";
    }
}
initRNNoise();

fileInput.addEventListener('change', async function(e) {
    if (!rnnoiseModule) {
        alert("AI model is still loading. Please wait a moment.");
        return;
    }

    const file = e.target.files[0];
    if (!file) return;

    fileLabel.innerText = file.name;
    progressWrapper.style.display = 'block';
    downloadBtn.style.display = 'none';
    
    statusText.innerText = "Loading and Decoding...";
    progressFill.style.width = "10%";

    try {
        // 1. Decode Audio
        const arrayBuffer = await file.arrayBuffer();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        let audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        // RNNoise strictly requires a 48kHz sample rate.
        // If the audio is not 48kHz, we must resample it.
        if (audioBuffer.sampleRate !== 48000) {
             statusText.innerText = "Resampling to 48kHz for AI processing...";
             progressFill.style.width = "20%";
             const offlineCtx = new OfflineAudioContext(1, audioBuffer.duration * 48000, 48000);
             const source = offlineCtx.createBufferSource();
             source.buffer = audioBuffer;
             source.connect(offlineCtx.destination);
             source.start(0);
             audioBuffer = await offlineCtx.startRendering();
        }

        statusText.innerText = "Initializing AI Noise Suppression...";
        progressFill.style.width = "30%";

        // 2. Prepare the data
        // RNNoise operates on mono audio. We will process only the first channel.
        const inputData = audioBuffer.getChannelData(0); 
        const outputData = new Float32Array(inputData.length);
        
        // RNNoise processes EXACTLY 480 samples at a time.
        const frameSize = 480;
        
        // Create an instance of the denoiser
        const denoiser = rnnoiseModule.create();

        // 3. Process Chunk by Chunk
        let offset = 0;
        const totalFrames = Math.floor(inputData.length / frameSize);
        let currentFrame = 0;

        // We use a recursive function with requestAnimationFrame to prevent blocking the UI
        function processNextChunk() {
            // Process a batch of frames per UI update so it doesn't take forever,
            // but small enough so the browser doesn't freeze.
            const framesPerBatch = 100; 
            
            for (let i = 0; i < framesPerBatch && offset + frameSize <= inputData.length; i++) {
                // Get the next 480 samples
                const frame = inputData.subarray(offset, offset + frameSize);
                
                // Process the frame through the AI model
                const cleanFrame = denoiser.process(frame);
                
                // Write the cleaned samples back out
                outputData.set(cleanFrame, offset);
                
                offset += frameSize;
                currentFrame++;
            }

            // Update Progress Bar
            const percentComplete = 30 + Math.floor((currentFrame / totalFrames) * 60);
            progressFill.style.width = percentComplete + "%";
            statusText.innerText = `Removing noise... ${Math.floor((currentFrame / totalFrames) * 100)}%`;

            if (offset + frameSize <= inputData.length) {
                // Schedule the next batch to allow the browser to breathe
                requestAnimationFrame(processNextChunk);
            } else {
                // 4. Processing Complete. Rebuild the audio.
                finishProcessing(outputData);
            }
        }

        // Start the chunking process
        processNextChunk();

        function finishProcessing(cleanedData) {
            statusText.innerText = "Encoding to WAV format...";
            progressFill.style.width = "95%";
            
            // Clean up the denoiser memory
            denoiser.destroy();

            // Create a new AudioBuffer with the cleaned data
            const cleanBuffer = audioCtx.createBuffer(1, cleanedData.length, 48000);
            cleanBuffer.copyToChannel(cleanedData, 0);

            // Encode to WAV
            const wavBlob = audioBufferToWav(cleanBuffer);
            
            downloadUrl = URL.createObjectURL(wavBlob);
            progressFill.style.width = "100%";
            statusText.innerText = "Done! Cleaned audio is ready.";
            downloadBtn.style.display = 'block';
        }

    } catch (error) {
        console.error(error);
        statusText.innerText = "Error processing audio. Check console.";
        statusText.style.color = "red";
    }
});

// Handle Download click
downloadBtn.addEventListener('click', () => {
    if (!downloadUrl) return;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = 'cleaned_dictation_ai.wav';
    a.click();
});

// --- Helper Function: Convert AudioBuffer to WAV (Synchronous for simplicity here) ---
function audioBufferToWav(buffer) {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44;
    const outBuffer = new ArrayBuffer(length);
    const view = new DataView(outBuffer);
    const channels = [];
    const sampleRate = buffer.sampleRate;
    let offset = 0, pos = 0;

    // Write WAV Header
    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16);         // length = 16
    setUint16(1);          // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(sampleRate);
    setUint32(sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2);              // block-align
    setUint16(16);                         // 16-bit

    setUint32(0x61746164); // "data" - chunk
    setUint32(length - pos - 4);

    for (let i = 0; i < buffer.numberOfChannels; i++)
        channels.push(buffer.getChannelData(i));

    while (pos < length) {
        for (let i = 0; i < numOfChan; i++) {
            let sample = Math.max(-1, Math.min(1, channels[i][offset])); 
            sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; 
            view.setInt16(pos, sample, true);

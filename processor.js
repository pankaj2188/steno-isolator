// UI Elements
const fileInput = document.getElementById('audio-upload');
const fileLabel = document.getElementById('file-label');
const progressWrapper = document.getElementById('progress-wrapper');
const progressFill = document.getElementById('progress-fill');
const statusText = document.getElementById('status-text');
const downloadBtn = document.getElementById('download-btn');

let downloadUrl = null;
let rnnoiseModule = null;

// Initialize RNNoise when the page loads
async function initRNNoise() {
    try {
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

        const inputData = audioBuffer.getChannelData(0); 
        const outputData = new Float32Array(inputData.length);
        const frameSize = 480; // RNNoise requires exactly 480 samples
        const denoiser = rnnoiseModule.create();

        // 3. Process Chunk by Chunk
        let offset = 0;
        const totalFrames = Math.floor(inputData.length / frameSize);
        let currentFrame = 0;

        function processNextChunk() {
            const framesPerBatch = 100; 
            
            for (let i = 0; i < framesPerBatch && offset + frameSize <= inputData.length; i++) {
                
                // Create a temporary array for the AI
                const frame = new Float32Array(frameSize);
                
                // STEP A: Scale the browser audio UP to 16-bit PCM for the AI
                for (let j = 0; j < frameSize; j++) {
                    frame[j] = inputData[offset + j] * 32767;
                }
                
                // Process the frame (AI cleans the noise)
                denoiser.process(frame);
                
                // STEP B: Scale the cleaned audio BACK DOWN for the browser
                for (let j = 0; j < frameSize; j++) {
                    outputData[offset + j] = frame[j] / 32767;
                }
                
                offset += frameSize;
                currentFrame++;
            }

            // Update Progress Bar
            const percentComplete = 30 + Math.floor((currentFrame / totalFrames) * 60);
            progressFill.style.width = percentComplete + "%";
            statusText.innerText = `Removing noise... ${Math.floor((currentFrame / totalFrames) * 100)}%`;

            if (offset + frameSize <= inputData.length) {
                requestAnimationFrame(processNextChunk); // Let the processor breathe
            } else {
                finishProcessing(outputData);
            }
        }

        processNextChunk();

        function finishProcessing(cleanedData) {
            statusText.innerText = "Encoding to WAV format...";
            progressFill.style.width = "95%";
            
            denoiser.destroy(); // Free memory

            const cleanBuffer = audioCtx.createBuffer(1, cleanedData.length, 48000);
            cleanBuffer.copyToChannel(cleanedData, 0);

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

// --- Helper Function: Convert AudioBuffer to WAV ---
function audioBufferToWav(buffer) {
    const numOfChan = buffer.numberOfChannels;
    const length = buffer.length * numOfChan * 2 + 44;
    const outBuffer = new ArrayBuffer(length);
    const view = new DataView(outBuffer);
    const channels = [];
    const sampleRate = buffer.sampleRate;
    let offset = 0, pos = 0;

    // WAV Header
    setUint32(0x46464952); 
    setUint32(length - 8); 
    setUint32(0x45564157); 
    setUint32(0x20746d66); 
    setUint32(16);         
    setUint16(1);          
    setUint16(numOfChan);
    setUint32(sampleRate);
    setUint32(sampleRate * 2 * numOfChan); 
    setUint16(numOfChan * 2);              
    setUint16(16);                         

    setUint32(0x61746164); 
    setUint32(length - pos - 4);

    for (let i = 0; i < buffer.numberOfChannels; i++)
        channels.push(buffer.getChannelData(i));

    while (pos < length) {
        for (let i = 0; i < numOfChan; i++) {
            let sample = Math.max(-1, Math.min(1, channels[i][offset])); 
            sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; 
            view.setInt16(pos, sample, true); 
            pos += 2;
        }
        offset++;
    }

    return new Blob([outBuffer], { type: "audio/wav" });

    function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }
}

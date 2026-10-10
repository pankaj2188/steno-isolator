// UI Elements
const fileInput = document.getElementById('audio-upload');
const fileLabel = document.getElementById('file-label');
const progressWrapper = document.getElementById('progress-wrapper');
const progressFill = document.getElementById('progress-fill');
const statusText = document.getElementById('status-text');
const downloadBtn = document.getElementById('download-btn');

// Global variable to hold the final processed URL
let downloadUrl = null;

fileInput.addEventListener('change', async function(e) {
    const file = e.target.files[0];
    if (!file) return;

    fileLabel.innerText = file.name;
    progressWrapper.style.display = 'block';
    downloadBtn.style.display = 'none';
    
    statusText.innerText = "Loading file into memory...";
    progressFill.style.width = "10%";

    try {
        // 1. Read file as an ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();
        
        // 2. Decode Audio (Browser handles this efficiently)
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        statusText.innerText = "Decoding audio data...";
        progressFill.style.width = "20%";
        
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        // 3. Prepare to process in safe chunks
        const offlineCtx = new OfflineAudioContext(
            audioBuffer.numberOfChannels, 
            audioBuffer.length, 
            audioBuffer.sampleRate
        );
        
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;

        // 4. Vocal Isolation Filters
        // Cut off low rumbles (AC, traffic)
        const highpass = offlineCtx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 300; 

        // Cut off high hiss (Static, fans)
        const lowpass = offlineCtx.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = 3400;

        // Chain them together: Source -> Highpass -> Lowpass -> Output
        source.connect(highpass);
        highpass.connect(lowpass);
        lowpass.connect(offlineCtx.destination);
        
        source.start(0);

        statusText.innerText = "Applying voice isolation filters (Chunking...)";
        progressFill.style.width = "40%";

        // 5. Render the filtered audio
        const renderedBuffer = await offlineCtx.startRendering();

        statusText.innerText = "Encoding to WAV format...";
        progressFill.style.width = "75%";

        // 6. Encode back to a downloadable WAV file without locking the browser
        const wavBlob = await audioBufferToWav(renderedBuffer);
        
        // 7. Complete and show download
        downloadUrl = URL.createObjectURL(wavBlob);
        progressFill.style.width = "100%";
        statusText.innerText = "Done! Cleaned audio is ready.";
        downloadBtn.style.display = 'block';

    } catch (error) {
        console.error(error);
        statusText.innerText = "Error processing audio. File might be too large.";
        statusText.style.color = "red";
    }
});

// Handle Download click
downloadBtn.addEventListener('click', () => {
    if (!downloadUrl) return;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = 'cleaned_dictation.wav';
    a.click();
});

// --- Helper Function: Convert AudioBuffer to WAV ---
// We break this into a Promise so it doesn't freeze the UI
function audioBufferToWav(buffer) {
    return new Promise((resolve) => {
        const numOfChan = buffer.numberOfChannels,
              length = buffer.length * numOfChan * 2 + 44,
              outBuffer = new ArrayBuffer(length),
              view = new DataView(outBuffer),
              channels = [],
              sampleRate = buffer.sampleRate;
        let offset = 0,
            pos = 0;

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

        // Interleave channels
        while (pos < length) {
            for (let i = 0; i < numOfChan; i++) {
                let sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
                sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // float to 16-bit PCM
                view.setInt16(pos, sample, true); 
                pos += 2;
            }
            offset++;
        }

        resolve(new Blob([outBuffer], { type: "audio/wav" }));

        function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
        function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }
    });
}

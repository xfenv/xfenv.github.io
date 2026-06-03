/* CHECK BROWSER SUPPORT ----------------------------------------------------------------------- */
if (!('serial' in navigator)) {
  alert('Web Serial API is not supported in this browser. Please use Chrome, Edge, or Opera.');
}

/* SERIAL TIMEOUT ------------------------------------------------------------------------------ */
/**
 * Show timeout warning.
 * @param {boolean} show - true or false
 */
function showTimeoutWarning(show)
{
  const element = document.getElementById('connTimeout');
  if(element) element.style.display = show ? 'inline' : 'none';
}

/**
 * Force serial to disconnect.
 */
function forceDisconnect()
{
  console.log('Force disconnect');
  disconnect(true);  // unused boolean
}

/* SERIAL CONNECTION FUNCTIONS ----------------------------------------------------------------- */
// uses Aleksei Tertychnyi's JavaScript Web Serial functions
// serial connection variables
let baudRate = 115200;
let port = null;
let reader = null;
let writer = null;
let readLoop = null;
let isConnected = false;
// timing / buffering variables
const MAX_BUFFER_SIZE = 65536;
let receiveBuffer = [];
let lastReceiveTime = 0;
let bufferTimeout = null;

/**
 * Toggle serial connection.
 */
async function toggleConnection()
{
  const btn = document.getElementById('connectBtn');
  if (!isConnected) {
    flushReceiveBuffer();
    try{
      port = await navigator.serial.requestPort();
      if (!baudRate||baudRate<1||baudRate>10000000) {
        alert('Invalid baud rate configuration (1-10,000,000)');
        return;
      }
      const options = {baudRate:baudRate,dataBits:8,stopBits:1,parity:"none",flowControl:"none",bufferSize:8192};
      await port.open(options);

      if (port.readable) {
        const flushReader = port.readable.getReader();
        await flushReader.cancel();
        flushReader.releaseLock();
      }
      writer = port.writable.getWriter();
      reader = port.readable.getReader();
      isConnected = true;
      btn.textContent='DISCONNECT';
      btn.classList.add('active');
      updateStatus(true);
      showTimeoutWarning(false);
      readLoop = readData();
    } catch (err) {
      console.error('Connection error:', err);
      // skip alert if user cancelled port selection
      if (err.name!=='NotFoundError'&&!err.message?.includes('No port selected')) {
        alert('Failed to connect: ' + err.message);
      }
      await disconnect();
    }
  } else {await disconnect();}
}

/**
 * Disconnect serial port.
 * @param {boolean} force - true or false -> force disconnect?
 */
async function disconnect(force=false)
{
  const btn = document.getElementById('connectBtn');
  btn.disabled = true;
  isConnected = false;
  updateStatus(false);
  showTimeoutWarning(false);

  if (bufferTimeout) {
    clearTimeout(bufferTimeout);
    bufferTimeout=null;
  }
  receiveBuffer=[];

  if (reader) {
    try {
      const cancelPromise = reader.cancel();
      const timeoutPromise = new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')), 2000));
      await Promise.race([cancelPromise, timeoutPromise]);
    } catch (e) {console.warn('Reader cancel failed:', e);}
    try {reader.releaseLock();} catch (e) {}
    reader = null;
  }

  if (writer) {
    try {writer.releaseLock();} catch (e) {}
    writer = null;
  }

  if (port) {
    try {
      const closePromise = port.close();
      const timeoutPromise = new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')), 3000));
      await Promise.race([closePromise, timeoutPromise]);
    } catch (e) {
      console.warn('Port close failed:', e);
      if (port && 'forget' in port) try {await port.forget();} catch (e2) {}
    }
    port = null;
  }

  btn.textContent='CONNECT';
  btn.classList.remove('active');
  btn.disabled = false;
}

/**
 * Read data from serial port.
 */
async function readData()
{
  let stuckTimer = null;
  try {
    while (isConnected&&reader) {
      stuckTimer = setTimeout(()=>{if (isConnected) showTimeoutWarning(true);}, 5000);
      let result;
      try {result = await reader.read();} finally {clearTimeout(stuckTimer);}
      const {value, done} = result;
      if (done) break;
      if (value&&value.length>0) {
        showTimeoutWarning(false);
        const now = Date.now();
        const timingEnabled = false;
        const timingThreshold = 50000;
        if (timingEnabled) {
          const timeSinceLast = (now-lastReceiveTime);
          if (timeSinceLast>timingThreshold&&receiveBuffer.length>0) flushReceiveBuffer();
          if (receiveBuffer.length+value.length>MAX_BUFFER_SIZE) flushReceiveBuffer();
          receiveBuffer.push(...value);
          lastReceiveTime = now;
          if (bufferTimeout) clearTimeout(bufferTimeout);
          bufferTimeout = setTimeout(()=>{if (receiveBuffer.length>0) flushReceiveBuffer();}, Math.max(timingThreshold+10, 50));
        } else {processReceivedData(value);}
      }
      await new Promise(resolve=>setTimeout(resolve, 0));
    }
  } catch (err) {
    if (isConnected) {
      console.error('Read error:', err);
      if (err.name==='NetworkError'||err.message.includes('device disconnected')) {
        await disconnect();
      } else {
        showTimeoutWarning(true);
        setTimeout(()=>{if (isConnected) showTimeoutWarning(false);}, 3000);
      }
    }
  } finally {if (stuckTimer) clearTimeout(stuckTimer);}
}

/**
 * Flush receive buffer.
 */
function flushReceiveBuffer()
{
  if (receiveBuffer.length === 0) return;

  const data = new Uint8Array(receiveBuffer);
  processReceivedData(data);
  receiveBuffer = [];
}

/**
 * Send commands to MCU as hex values.
 */
async function sendHex()
{
  if (!isConnected || !writer) {
    alert('Please connect to ISC Scope first!');
    return;
  }
  const inputFreq = document.getElementById('gen-freq');
  const inputType = document.getElementById('gen-wave');
  const inputAttn = document.getElementById('gen-attn');
  const inputTrig = document.getElementById('gen-trig');
  const inputAmp1 = document.getElementById('ch1-type');
  const inputAmp2 = document.getElementById('ch2-type');

  const freq = Number.parseInt(inputFreq?.value ?? '0', 10) >>> 0;  // uint32
  const type = Number.parseInt(inputType?.value ?? '0', 10) & 0x03; // 2 bits
  const attn = Number.parseInt(inputAttn?.value ?? '0', 10) & 0x03; // 2 bits
  const trig = Number.parseInt(inputTrig?.value ?? '0', 10) >>> 0;  // uint16
  const amp1 = Number.parseInt(inputAmp1?.value ?? '0', 10) & 0x01; // 1 bit
  const amp2 = Number.parseInt(inputAmp2?.value ?? '0', 10) & 0x01; // 1 bit
  
  // clamp input frequency and show it in the UI
  const freqClamped = Math.min(Math.max(freq, 10), 50000) >>> 0;
  inputFreq.value = freqClamped;

  // sample rate adjustment
  if (freq < 1000) {
		sampleRateHz = 10000;
	} else if (freq < 5000) {
		sampleRateHz = 50000;
	} else if (freq < 10000) {
		sampleRateHz = 100000;
	} else {
		sampleRateHz = 300000;
	}

  const mode = (amp1 << 5) | (amp2 << 4) | (type << 2) | (attn);

  const data = new Uint8Array([
    0x47, 0xF7, 0xF7,
    (trig >>>  8) & 0xFF,
    (trig >>>  0) & 0xFF,
    mode,
    (freqClamped >>> 24) & 0xFF,
    (freqClamped >>> 16) & 0xFF,
    (freqClamped >>>  8) & 0xFF,
    (freqClamped >>>  0) & 0xFF
  ]);

  try {
    await writer.write(data);
    console.log('CMD sent!', data);
  } catch (err) {
    console.error('Send error:', err);
    alert('Failed to send: ' + err.message);
  }
  updateScopeScales();
}

/**
 * Update status indicator.
 * @param {boolean} connected
 */
function updateStatus(connected)
{
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const isLightTheme = document.body.classList.contains('light');

  if (connected) {
    dot.classList.add('connected');
    text.textContent = `Connected (${baudRate} baud)`;
    // dark green for light theme, bright green for dark theme
    text.style.color = isLightTheme ? '#1a7a3a' : '#2ed573';
  } else {
    dot.classList.remove('connected');
    text.textContent = 'Disconnected';
    // dark red for light theme, light gray for dark theme
    text.style.color = isLightTheme ? '#dc3545' : '#e0e0e0';
  }
}

/* DATA PROCESSING FUNCTIONS ------------------------------------------------------------------- */
// USB protocol constants
const usbMagic = [0x69, 0xF7, 0x69, 0xF7, 0x00];
const usbHeaderSize = 16;
const payloadTotalSize = 4096;  // only ADC1/2 data as 8b values
// frame state variables
let rxBuffer = [];
let frameBuffer = null;
let frameOffset = 0;            // no offset by default
let expectedIndex = 0;          // first index of a frame is 0

/**
 * Find MAGIC header from USB buffer.
 * @param {Array} buffer - data in buffer
 * @returns index of first detection byte or -1 if not found
 */
function findMagic(buffer)
{
  for (let i=0; i<=buffer.length-5; i++) {
    let match = true;
    for (let j=0; j<5; j++) {
      if (buffer[i + j] !== usbMagic[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Process received data.
 * @param {Uint8Array} data - incoming data as uint8 values
 */
function processReceivedData(data)
{
  rxBuffer.push(...data); // incoming data chuncks are appended to rolling buffer

  while (true) {
    if (rxBuffer.length < usbHeaderSize) return;  // header won't fit

    // find detection bytes from the buffer
    let magicIndex = findMagic(rxBuffer);
    if (magicIndex === -1) {  // no detection, keep last 4 bytes
      rxBuffer = rxBuffer.slice(-4);
      return;
    }
    // if detection bytes are not the first in the array discard bytes til magic
    if (magicIndex > 0) {
      rxBuffer = rxBuffer.slice(magicIndex);
    }
    // detection bytes first in the buffer, but header is incomplete
    if (rxBuffer.length < usbHeaderSize) return;

    // parse header
    const packetIndex = rxBuffer[5];
    const ctrlSum1 = (rxBuffer[6] << 24) |
                      (rxBuffer[7] << 16) |
                      (rxBuffer[8] << 8) |
                      (rxBuffer[9]);
    const ctrlSum2 = (rxBuffer[10] << 24) |
                      (rxBuffer[11] << 16) |
                      (rxBuffer[12] << 8) |
                      (rxBuffer[13]);
    const payloadLen = (rxBuffer[14] << 8) | (rxBuffer[15]);
    const packetSize = usbHeaderSize + payloadLen;

    // packet not full
    if (rxBuffer.length < packetSize) return;

    // extract payload
    const payload = rxBuffer.slice(16, 16 + payloadLen);

    // start a new frame if packet index is 0
    if (packetIndex === 0) {
      frameBuffer = new Uint8Array(payloadTotalSize);
      frameOffset = 0;
      expectedIndex = 0;
    }

    if (frameBuffer && packetIndex === expectedIndex) {
      frameBuffer.set(payload, frameOffset);
      frameOffset += payloadLen;
      expectedIndex++;
      
      if (expectedIndex === 5) {  // frame complete
        if (frameOffset === payloadTotalSize) {
          divideDataIntoChannels(frameBuffer);
        } else {
          console.warn("Frame size mismatch:", frameOffset);
        }
        // reset index for the next frame
        frameBuffer = null;
        expectedIndex = 0;
        frameOffset = 0;
      }
    } else {  // reset out of sync frame
      frameBuffer = null;
      expectedIndex = 0;
      frameOffset = 0;
      console.warn("Frame out of sync!");
    }

    // remove processed packet from the ring buffer
    rxBuffer = rxBuffer.slice(packetSize);
  }
}

/**
 * Divide raw ADC values into two channels.
 * @param {Uint8Array} frameBuf
 */
function divideDataIntoChannels(frameBuf)
{
  const sampleCount = frameBuf.length >> 1; // bitshift division by 2 -> 2048
  const channelLength = sampleCount >> 1;   // 2048 / 2 -> 1024 per channel
  const ch1Values = new Int16Array(channelLength);
  const ch2Values = new Int16Array(channelLength);

  let channelIndex = 0;
  // data is formatted - [CH1_H, CH1_L, CH2_H, CH2_L, ...]
  for (let i=0; i<frameBuf.length; i+=4) {
    let val1 = (frameBuf[i] << 8) | frameBuf[i + 1];
    let val2 = (frameBuf[i + 2] << 8) | frameBuf[i + 3];
    ch1Values[channelIndex] = val1;
    ch2Values[channelIndex] = val2;
    channelIndex++;
  }
  plotFrame(ch1Values, ch2Values);
}

/* SCOPE DRAWING FUNCTIONS --------------------------------------------------------------------- */
// scope constants
const zeroVoltLevel = 2047;
const adcTomV = (3300 / 4095) * 3.05; // (ADC ref mV) / (ADC max val) * (hardware gain comp)
const xDivs = 10;
const yDivs = 8;
// scope & canvas variables
let gridCanvas, gridCtx;
let canvas, ctx;
let isRunning = true;
let triggerLevel = 2047;
let sampleRateHz = 50000;
let timeMsPerDiv = 1;
let samplesPerScreen, ch1ScaleFactor, ch2ScaleFactor;
let padding = 10;

/**
 * Update the value of triggerLevel upon change.
 */
function updateTriggerLevel()
{
  const slider = document.getElementById('gen-trig');
  if (!slider) return;
  triggerLevel = Number(slider.value);
}

/**
 * Update the values of timeMsPerDiv, ch1mVPerDiv and ch2mVPerDiv.
 */
function updateScopeScales()
{
  const timeSel = document.getElementById('time-scale');
  const ch1Sel = document.getElementById('ch1-scale');
  const ch2Sel = document.getElementById('ch2-scale');

  // calculate amount of samples on the screen
  if (timeSel) samplesPerScreen = Math.floor((sampleRateHz*Number(timeSel.value)*xDivs) / 1000);
  // calculate voltage scales
  const yPixelsPerDiv = (canvas.height - 2*padding) / yDivs;
  if (ch1Sel) ch1ScaleFactor = yPixelsPerDiv / Number(ch1Sel.value);
  if (ch2Sel) ch2ScaleFactor = yPixelsPerDiv / Number(ch2Sel.value);
}

/**
 * Update variables on load & add hooks.
 */
window.addEventListener('DOMContentLoaded', () => {
  gridCanvas = document.createElement('canvas');
  gridCtx = gridCanvas.getContext('2d');
  canvas = document.getElementById('screen');
  ctx = canvas.getContext('2d');
  drawGrid(canvas.width, canvas.height);

  document.getElementById('time-scale')?.addEventListener('change', updateScopeScales);
  document.getElementById('ch1-scale')?.addEventListener('change', updateScopeScales);
  document.getElementById('ch2-scale')?.addEventListener('change', updateScopeScales);
  // also update scale selections
  updateScopeScales();
});

/**
 * Toggle scope display update.
 */
function toggleDisplayUpdate()
{
  const btn = document.getElementById('stopBtn');
  
  isRunning = !isRunning;
  btn.classList.toggle('active');
  btn.textContent = isRunning ? 'STOP' : 'RUN';
}

/**
 * Draw the oscilloscope background grid.
 * @param {Number} width - canvas width
 * @param {Number} height - canvas height
 */
function drawGrid(width, height)
{
  const xStep = (width - 2 * padding) / xDivs;
  const yStep = (height - 2 * padding) / yDivs;
  gridCanvas.width = width;
  gridCanvas.height = height;

  gridCtx.save();

  // clear background
  gridCtx.fillStyle = isLightTheme ? '#FFFFFF' : '#000000';
  gridCtx.fillRect(0, 0, width, height);
  
  // grid style depending on theme
  gridCtx.strokeStyle = isLightTheme ? '#BABABA' : '#404040';
  gridCtx.lineWidth = 1;
  gridCtx.beginPath();
  // vertical lines
  for (let i=0; i<=xDivs; i++) {
    const x = padding + i*xStep;
    gridCtx.moveTo(x, padding);
    gridCtx.lineTo(x, height-padding);
  }
  // horizontal lines
  for (let i=0; i<=yDivs; i++) {
    const y = padding + i*yStep;
    gridCtx.moveTo(padding, y);
    gridCtx.lineTo(width-padding, y);
  }
  gridCtx.stroke();

  // horizontal centre
  gridCtx.strokeStyle = isLightTheme ? '#404040' : '#BABABA';
  gridCtx.lineWidth = 1.5;
  gridCtx.beginPath();
  const centerY = padding + (height - 2 * padding) / 2;
  gridCtx.moveTo(padding, centerY);
  gridCtx.lineTo(width-padding, centerY);
  gridCtx.stroke();

  gridCtx.restore();
}

/**
 * Draw trigger level line and scale it to CH1.
 *
 * @param {Number} width - canvas width
 * @param {Number} height - canvas height
 */
function drawTrigger(width, height)
{
  const mV = (triggerLevel - zeroVoltLevel) * adcTomV;
  // clamp to visible scope area
  const clampedY = Math.max(padding, Math.min(height-padding, (height/2) - (mV*ch1ScaleFactor)));

  ctx.save();
  // dashed trigger line
  ctx.strokeStyle = "#ff0088";
  ctx.lineWidth = 1.2;
  ctx.setLineDash([16, 8]);

  ctx.beginPath();
  ctx.moveTo(padding, clampedY);
  ctx.lineTo(width-padding, clampedY);
  ctx.stroke();

  ctx.restore();
}

/**
 * Plot full scope frame.
 * @param {Uint8Array} ch1 - readings from ADC1
 * @param {Uint8Array} ch2 - readings from ADC1
 * @returns null
 */
function plotFrame(ch1, ch2) {
  if (!isRunning || !canvas || !ctx) return;

  const width = canvas.width;
  const height = canvas.height;

  // background grid and trigger line
  ctx.drawImage(gridCanvas, 0, 0);
  drawTrigger(width, height);

  // time scaling (ms)
  const visibleSamples = Math.min(samplesPerScreen, ch1.length);  // in case not enough data
  if (visibleSamples === 0) return;
  const xStep = (width - 2*padding) / (visibleSamples-1); // -1 because between x values is x-1 divs

  // calculate data
  scopeMeasurements(ch1, ch2);

  // draw ch1 data
  ctx.save();
  ctx.strokeStyle = "#94b1ff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let i=0; i<visibleSamples; i++) {
    const x = padding + i*xStep;
    const mV = (ch1[i]-zeroVoltLevel) * adcTomV;
    const y = Math.max(padding, Math.min(height-padding, (height/2) - (mV*ch1ScaleFactor)));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // draw ch2 data
  ctx.save();
  ctx.strokeStyle = "#ff6600";
  ctx.lineWidth = 1.5;
  ctx.beginPath();

  for (let i=0; i<visibleSamples; i++) {
    const x = padding + i*xStep;
    const mV = (ch2[i] - zeroVoltLevel) * adcTomV;
    const y = Math.max(padding, Math.min(height-padding, (height/2) - (mV*ch2ScaleFactor)));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

/* MEASUREMENTS -------------------------------------------------------------------------------- */
/**
 * Calculate RMS from array using adcTomV conversion.
 * @param {Uint8Array} values - measurement data
 * @param {Number} len - length of values
 * @param {Number} offset - 0V offset
 * @param {Number} mvPerADCCount - mV per number in ADC result
 * @returns RMS of array relative to offset
 */
function calcRMS(values, len, offset, mvPerADCCount)
{
  let sumRMS = 0.0;
  for (let i=0; i<len; i++) {
    const val = (values[i]-offset) * mvPerADCCount;
    sumRMS += val * val;
  }
  return Math.sqrt(sumRMS / Math.max(1, len));
}

/**
 * Estimate signal frequency.
 * @param {Uint8Array} values - measurement data
 * @param {Number} zeroLine - 0V line
 * @param {Number} sampleRate - sample rate
 * @returns estimated frequency
 */
function estimateFrequency(values, zeroLine, sampleRate) {
  let crossings = 0;
  for (let i=1; i<values.length; i++) {
    // check if the signal crossed the zero line
    if ((values[i] >= zeroLine && values[i-1] < zeroLine) ||
        (values[i] < zeroLine && values[i-1] >= zeroLine)) {
      crossings++;
    }
  }
  return (crossings*sampleRate) / (2 * (values.length -1))
}

/**
 * Calculate phase shift between 2 signals.
 * @param {Uint8Array} signalA - first signal
 * @param {Uint8Array} signalB - second signal
 * @param {Number} frequency - estimated signal frequency
 * @param {Number} sampleRate - sample rate
 * @returns {Number} - phase shift in degrees
 */
function calculatePhaseShift(signalA, signalB, frequency, sampleRate) {
  const n = signalA.length;
  let maxCorrelation = -Infinity;
  let sampleDelay = 0;
  let meanA = 0;
  let meanB = 0;

  // search for best match by shifting signal B (lag), while limiting search to one period
  const periodInSamples = Math.floor(sampleRate / frequency);
  const searchRange = Math.min(n, periodInSamples);

  // calculate DC offset
  for (let i=0; i<n; i++) {
    meanA += signalA[i];
    meanB += signalB[i];
  }
  meanA /= n
  meanB /= n

  // find correlation
  for (let lag=-searchRange; lag<searchRange; lag++) {
    let correlation = 0;
    for (let i=0; i<n; i++) {
      const j = i + lag;
      if (j >= 0 && j < n) {
        correlation += (signalA[i]-meanA) * (signalB[j]-meanB);
      }
    }
    if (correlation > maxCorrelation) {
      maxCorrelation = correlation;
      sampleDelay = lag;
    }
  }
  // calculate phaseshift
  return (sampleDelay/periodInSamples) * -360;
}

/**
 * Measurement data text updater.
 * @param {Text} elementId - where to write
 * @param {Text} text - text to write
 */
function updateText(elementId, text)
{
  const el = document.getElementById(elementId);
  if (el) el.textContent = text;
}

/**
 * Update measurement values.
 * @param {Number} rms1 - ch1 rms
 * @param {Number} rms2 - ch2 rms
 * @param {Number} freq1 - ch1 frequency
 * @param {Number} freq2 - ch2 frequency
 * @param {Number} phase - phase shift
 */
function measurementUpdate(rms1, rms2, freq1, freq2, phase)
{
  const formatRMS = (rms) => {
    if (!Number.isFinite(rms)) return "- mV";
    if (rms>=1000) return (rms/1000).toFixed(3) + " V";
    else return rms.toFixed(1) + " mV"
  }
  const formatFreq = (freq) => {
    if (!Number.isFinite(freq)) return "- Hz";
    if (freq>=1000) return (freq/1000).toFixed(2) + " kHz";
    else return freq.toFixed(2) + " Hz"
  }
  const formatPhase = (phase) => {
    if (!Number.isFinite(phase)) return "-°";
    if (phase>=100) return phase.toFixed(1) + "°";
    else return phase.toFixed(2) + "°"
  }
  updateText('ch1-rms', formatRMS(rms1));
  updateText('ch2-rms', formatRMS(rms2));
  updateText('ch1-freq', formatFreq(freq1));
  updateText('ch2-freq', formatFreq(freq2));
  updateText('m-phase', formatPhase(phase));
}

/**
 * Wrapper for scope measurements.
 * @param {Uint8Array} valuesCh1 - ch1 measurements
 * @param {Uint8Array} valuesCh2 - ch2 measurements
 */
function scopeMeasurements(valuesCh1, valuesCh2)
{
  // calculate rms
  const rms1 = calcRMS(valuesCh1, valuesCh1.length, zeroVoltLevel, adcTomV);
  const rms2 = calcRMS(valuesCh2, valuesCh2.length, zeroVoltLevel, adcTomV);
  // estimate frequency and phase
  const freq1 = estimateFrequency(valuesCh1, zeroVoltLevel, sampleRateHz);
  const freq2 = estimateFrequency(valuesCh2, zeroVoltLevel, sampleRateHz);
  const phase = calculatePhaseShift(valuesCh1, valuesCh2, freq1, sampleRateHz);
  // update
  measurementUpdate(rms1, rms2, freq1, freq2, phase);
}

/* THEME TOGGLE -------------------------------------------------------------------------------- */
let isLightTheme = false;

/**
 * Toggle site theme.
 */
function toggleTheme()
{
  isLightTheme = !isLightTheme;
  document.body.classList.toggle('light', isLightTheme);  // TODO: ADD THEMES IN CSS & TOGGLE IN HTML
  document.getElementById('themeIcon').textContent  = isLightTheme ? '☀️' : '🌙';
  document.getElementById('themeLabel').textContent = isLightTheme ? 'Light' : 'Dark';
  // refresh colors immediately
  drawGrid(canvas.width, canvas.height);
  updateStatus(isConnected);
}

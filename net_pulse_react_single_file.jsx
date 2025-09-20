/*
NetPulse - Internet Speed Test (Single-file React component)

Features:
- Modern dark UI with gradient accents
- Concurrent multi-stream download test for realistic throughput
- Upload test using streamed POST (Blob)
- Ping measurement (median of multiple HEAD requests)
- Animated circular gauges (react-circular-progressbar)
- Result summary with average and peak speeds
- Adjustable settings: number of streams, download size per stream, upload size

Dependencies (install these in your project):
  npm install react-circular-progressbar recharts framer-motion

Notes:
- Browser speed tests are approximate and depend on server CORS and throttling.
- Replace DOWNLOAD_TEST_URL with a CORS-enabled static file for best results.
- Replace UPLOAD_ENDPOINT with a dedicated endpoint for accurate upload testing.
*/

import React, { useState, useRef } from 'react';
import { CircularProgressbar, buildStyles } from 'react-circular-progressbar';
import 'react-circular-progressbar/dist/styles.css';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { motion } from 'framer-motion';

// --- Configuration ---
const DOWNLOAD_TEST_URL = 'https://speed.hetzner.de/100MB.bin'; // replace with a CORS-friendly endpoint
const UPLOAD_ENDPOINT = 'https://httpbin.org/post'; // replace with your upload receiver for production

// Defaults for UI settings
const DEFAULT_STREAMS = 4; // how many parallel downloads to run
const DEFAULT_SIZE_MB_PER_STREAM = 10; // how many MB each stream should try to download (best-effort)
const DEFAULT_UPLOAD_MB = 10; // upload size in MB
const PING_TRIES = 5; // how many ping HEAD requests to make

export default function NetPulse() {
  // --- UI State ---
  const [running, setRunning] = useState(false);
  const [streams, setStreams] = useState(DEFAULT_STREAMS);
  const [sizePerStream, setSizePerStream] = useState(DEFAULT_SIZE_MB_PER_STREAM);
  const [uploadSize, setUploadSize] = useState(DEFAULT_UPLOAD_MB);

  // Results
  const [pingMs, setPingMs] = useState(null);
  const [downloadMbps, setDownloadMbps] = useState(null);
  const [downloadPeakMbps, setDownloadPeakMbps] = useState(null);
  const [uploadMbps, setUploadMbps] = useState(null);

  // Live telemetry for chart & gauges
  const [dlChartData, setDlChartData] = useState([]); // timeline of aggregate KB/sec values
  const [log, setLog] = useState([]);

  // Abort controller to cancel running fetches
  const controllerRef = useRef(null);

  // Helper: push log (keeps up to 50 messages)
  const pushLog = (msg) => setLog((l) => [
    `${new Date().toLocaleTimeString()} — ${msg}`,
    ...l
  ].slice(0, 50));

  // --- Ping measurement ---
  async function measurePing() {
    const url = 'https://www.google.com/favicon.ico';
    const results = [];
    for (let i = 0; i < PING_TRIES; i++) {
      const start = performance.now();
      try {
        // HEAD reduces body transfer — still counts round-trip time
        await fetch(`${url}?_=${Math.random()}`, { method: 'HEAD', cache: 'no-store' });
        const delta = performance.now() - start;
        results.push(delta);
        pushLog(`Ping ${i + 1}: ${Math.round(delta)} ms`);
      } catch (e) {
        pushLog(`Ping ${i + 1}: failed`);
      }
    }
    if (results.length === 0) return null;
    results.sort((a, b) => a - b);
    const median = results[Math.floor(results.length / 2)];
    return Math.round(median);
  }

  // --- Concurrent download measurement ---
  // Approach:
  // - Start N parallel fetches to the same test file (cache-busted)
  // - For each stream, read the response body via reader.read() and tally bytes
  // - Sample aggregate throughput frequently and push to chart
  // - Stop each stream when it reaches target bytes (sizePerStream) or when aborted
  async function measureDownloadParallel(numStreams, mbPerStream, onProgress) {
    // Calculate target bytes per stream
    const targetBytes = mbPerStream * 1024 * 1024;
    controllerRef.current = new AbortController();
    const signal = controllerRef.current.signal;

    // Keep per-stream state
    const streamStates = Array.from({ length: numStreams }, () => ({ bytes: 0, start: null }));
    let running = true;

    // Helper to create a single stream promise
    const makeStream = async (index) => {
      const url = `${DOWNLOAD_TEST_URL}?_=${Math.random()}`; // cache-bust
      pushLog(`Starting stream ${index + 1} → target ${(mbPerStream).toFixed(1)} MB`);
      const res = await fetch(url, { signal });
      if (!res.body) throw new Error('Streaming not supported by this response');
      const reader = res.body.getReader();
      streamStates[index].start = performance.now();
      let doneReading = false;

      try {
        while (!doneReading && !signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          streamStates[index].bytes += value.length;

          // If stream reached target, we break out early (we don't need entire file)
          if (streamStates[index].bytes >= targetBytes) {
            // close reader by cancelling the stream (reader.releaseLock not sufficient across browsers)
            try { reader.cancel(); } catch (e) { /* ignore */ }
            break;
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') {
          // Aborted by user
          pushLog(`Stream ${index + 1} aborted`);
        } else {
          pushLog(`Stream ${index + 1} error: ${e.message}`);
        }
      }
    };

    // Start all streams in parallel
    const streamPromises = streamStates.map((_, i) => makeStream(i));

    // Periodic sampler: compute aggregate kbps and call onProgress
    const sampleIntervalMs = 500; // sample twice per second
    let lastSampleBytes = 0;
    let lastSampleTime = performance.now();
    const samples = []; // keep for peak calculation

    const sampler = setInterval(() => {
      const now = performance.now();
      const totalBytes = streamStates.reduce((s, st) => s + st.bytes, 0);
      const deltaBytes = totalBytes - lastSampleBytes;
      const deltaTime = (now - lastSampleTime) / 1000; // seconds
      lastSampleBytes = totalBytes;
      lastSampleTime = now;
      const kbps = deltaBytes / 1024 / deltaTime; // KB per second
      const mbps = (kbps * 8) / 1024; // convert to Mbps
      samples.push(mbps);
      // call progress callback with aggregate Mbps and totalBytes
      onProgress({ mbps: Number(mbps.toFixed(2)), totalBytes });
    }, sampleIntervalMs);

    // Wait for all streams to finish (either fulfilled or rejected)
    try {
      await Promise.allSettled(streamPromises);
      // Stop sampler
      clearInterval(sampler);
      running = false;

      // Final aggregate calculation
      const totalBytes = streamStates.reduce((s, st) => s + st.bytes, 0);
      const earliestStart = Math.min(...streamStates.filter(s=>s.start).map(s=>s.start));
      const elapsed = (performance.now() - earliestStart) / 1000;
      if (!elapsed || elapsed <= 0) return null;
      const bits = totalBytes * 8;
      const avgMbps = (bits / elapsed) / (1024 * 1024);
      const peak = samples.length ? Math.max(...samples) : avgMbps;
      return { avgMbps: Number(avgMbps.toFixed(2)), peakMbps: Number(peak.toFixed(2)), totalBytes };
    } catch (e) {
      clearInterval(sampler);
      throw e;
    }
  }

  // --- Upload measurement ---
  // Generates a random Blob of given size and POSTs it. Measures elapsed time.
  async function measureUpload(sizeMB) {
    const size = sizeMB * 1024 * 1024;
    pushLog(`Preparing ${sizeMB} MB upload payload`);
    // Generate a repeated random chunk to build the blob without allocating large typed arrays repetitively
    const chunkSize = 128 * 1024; // 128 KB
    const chunk = new Uint8Array(chunkSize);
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.floor(Math.random() * 256);
    const pieces = Math.ceil(size / chunkSize);
    const arr = new Array(pieces).fill(chunk);
    const blob = new Blob(arr, { type: 'application/octet-stream' });

    const start = performance.now();
    try {
      const res = await fetch(UPLOAD_ENDPOINT, { method: 'POST', body: blob });
      if (!res.ok) throw new Error(`Upload returned ${res.status}`);
      const seconds = (performance.now() - start) / 1000;
      const bits = size * 8;
      const mbps = (bits / seconds) / (1024 * 1024);
      pushLog(`Upload completed in ${seconds.toFixed(2)} s`);
      return Number(mbps.toFixed(2));
    } catch (e) {
      pushLog(`Upload failed: ${e.message}`);
      return null;
    }
  }

  // --- Orchestrator: full test flow ---
  async function runNetPulse() {
    setRunning(true);
    setDlChartData([]);
    setDownloadMbps(null);
    setDownloadPeakMbps(null);
    setUploadMbps(null);
    setPingMs(null);
    pushLog('--- NetPulse test started ---');

    try {
      // 1) Ping
      const ping = await measurePing();
      setPingMs(ping);

      // 2) Download (parallel streams). onProgress updates live chart
      const onProgress = ({ mbps, totalBytes }) => {
        // push the current mbps sample for live chart
        setDlChartData((d) => [...d.slice(-60), { name: new Date().toLocaleTimeString(), mbps }]);
      };

      const dlResult = await measureDownloadParallel(streams, sizePerStream, onProgress);
      if (dlResult) {
        setDownloadMbps(dlResult.avgMbps);
        setDownloadPeakMbps(dlResult.peakMbps);
        pushLog(`Download avg ${dlResult.avgMbps} Mbps (peak ${dlResult.peakMbps} Mbps)`);
      } else {
        pushLog('Download test failed');
      }

      // 3) Upload
      const ul = await measureUpload(uploadSize);
      setUploadMbps(ul);

      pushLog('--- NetPulse test finished ---');
    } catch (e) {
      pushLog(`Test error: ${e?.message ?? e}`);
    } finally {
      setRunning(false);
      if (controllerRef.current) controllerRef.current.abort();
      controllerRef.current = null;
    }
  }

  function abortTest() {
    if (controllerRef.current) controllerRef.current.abort();
    pushLog('User aborted test');
    setRunning(false);
  }

  // --- UI / JSX ---
  return (
    <div className="min-h-screen bg-gradient-to-b from-[#0f172a] to-[#071129] p-6 flex items-start justify-center text-white">
      <div className="w-full max-w-5xl bg-gradient-to-br from-[#0b1220]/60 via-[#071129]/50 to-[#081029]/60 shadow-2xl rounded-2xl p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Main controls and gauges */}
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-extrabold">NetPulse</h1>
              <p className="text-sm text-slate-300">Real-world concurrent speed test with beautiful gauges</p>
            </div>
            <div className="space-x-3 flex items-center">
              <button
                disabled={running}
                onClick={runNetPulse}
                className="px-5 py-2 bg-gradient-to-r from-[#06b6d4] to-[#7c3aed] rounded-full font-semibold shadow hover:scale-105 disabled:opacity-60"
              >
                {running ? 'Testing...' : 'Run NetPulse'}
              </button>
              <button
                onClick={abortTest}
                disabled={!running}
                className="px-4 py-2 border rounded-full hover:bg-white/5 disabled:opacity-50"
              >
                Abort
              </button>
            </div>
          </div>

          {/* Gauges */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-[#071428]/60 p-4 rounded-xl flex flex-col items-center">
              <div className="w-28 h-28">
                <CircularProgressbar
                  value={pingMs ? Math.min(pingMs, 500) : 0}
                  text={pingMs ? `${pingMs} ms` : '--'}
                  styles={buildStyles({
                    textColor: '#fff',
                    pathColor: pingMs === null ? '#334155' : pingMs < 60 ? '#10b981' : pingMs < 150 ? '#f59e0b' : '#ef4444',
                    trailColor: '#0b1220',
                  })}
                />
              </div>
              <div className="mt-3 text-sm text-slate-300">Ping (lower is better)</div>
            </div>

            <div className="bg-[#071428]/60 p-4 rounded-xl flex flex-col items-center">
              <div className="w-28 h-28">
                <CircularProgressbar
                  value={downloadMbps ?? 0}
                  maxValue={200} // visual scale (feel free to increase for higher links)
                  text={downloadMbps ? `${downloadMbps} Mbps` : '--'}
                  styles={buildStyles({
                    textColor: '#fff',
                    pathColor: '#7c3aed',
                    trailColor: '#0b1220',
                  })}
                />
              </div>
              <div className="mt-3 text-sm text-slate-300">Download (avg)</div>
              {downloadPeakMbps ? <div className="text-xs text-slate-400 mt-1">Peak: {downloadPeakMbps} Mbps</div> : null}
            </div>

            <div className="bg-[#071428]/60 p-4 rounded-xl flex flex-col items-center">
              <div className="w-28 h-28">
                <CircularProgressbar
                  value={uploadMbps ?? 0}
                  maxValue={100}
                  text={uploadMbps ? `${uploadMbps} Mbps` : '--'}
                  styles={buildStyles({
                    textColor: '#fff',
                    pathColor: '#06b6d4',
                    trailColor: '#0b1220',
                  })}
                />
              </div>
              <div className="mt-3 text-sm text-slate-300">Upload</div>
            </div>
          </div>

          {/* Live chart and log */}
          <div className="bg-[#071428]/50 rounded-xl p-4 mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Live Throughput</h3>
              <div className="text-xs text-slate-400">Aggregate Mbps over time</div>
            </div>
            <div style={{ width: '100%', height: 200 }}>
              <ResponsiveContainer>
                <LineChart data={dlChartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <XAxis dataKey="name" tick={{ fill: '#94a3b8' }} />
                  <YAxis tick={{ fill: '#94a3b8' }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="mbps" stroke="#7c3aed" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="bg-[#071428]/50 rounded-xl p-4">
            <h4 className="font-semibold mb-2">Activity Log</h4>
            <div className="h-40 overflow-y-auto text-sm text-slate-300">
              {log.length === 0 ? <div className="text-slate-500">No activity yet</div> : (
                <ul className="space-y-2">
                  {log.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              )}
            </div>
          </motion.div>
        </div>

        {/* Right: Settings / Summary */}
        <div className="p-4 rounded-xl bg-gradient-to-b from-[#061224] to-[#031826]">
          <h3 className="font-semibold mb-2">Settings</h3>
          <div className="space-y-3 text-sm mb-4">
            <div>
              <label className="block text-slate-300">Parallel streams: {streams}</label>
              <input type="range" min={1} max={8} value={streams} onChange={(e) => setStreams(Number(e.target.value))} />
            </div>
            <div>
              <label className="block text-slate-300">MB per stream: {sizePerStream} MB</label>
              <input type="range" min={1} max={50} value={sizePerStream} onChange={(e) => setSizePerStream(Number(e.target.value))} />
            </div>
            <div>
              <label className="block text-slate-300">Upload size: {uploadSize} MB</label>
              <input type="range" min={1} max={50} value={uploadSize} onChange={(e) => setUploadSize(Number(e.target.value))} />
            </div>
          </div>

          <div className="mb-4">
            <h3 className="font-semibold mb-2">Summary</h3>
            <div className="text-sm text-slate-300 space-y-2">
              <div>Ping: <span className="font-medium">{pingMs ?? '--'} ms</span></div>
              <div>Download: <span className="font-medium">{downloadMbps ?? '--'} Mbps</span></div>
              {downloadPeakMbps ? <div>Peak: <span className="font-medium">{downloadPeakMbps} Mbps</span></div> : null}
              <div>Upload: <span className="font-medium">{uploadMbps ?? '--'} Mbps</span></div>
            </div>
          </div>

          <div>
            <h3 className="font-semibold mb-2">Notes</h3>
            <ul className="text-xs text-slate-400 list-disc pl-5">
              <li>For best accuracy use a wired connection.</li>
              <li>Replace test endpoints with your own CORS-enabled hosts for production.</li>
              <li>High parallel streams may be limited by the server or network hardware.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

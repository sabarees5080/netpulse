/*
Internet Speed Test - Single File React Component
- Exports a default React component you can drop into a Create React App / Vite project.
- Uses Tailwind CSS for styling (ensure Tailwind is configured) and Recharts for a small speed chart.

Dependencies (install with npm/yarn):
  npm install recharts framer-motion

Notes & caveats:
- Browser-based speed tests are approximate. They rely on downloading/uploading files from remote servers and will be affected by CORS and server limits.
- Replace TEST_DOWNLOAD_URL with a fast static file (one that allows CORS). The example uses a placeholder and may need to be changed.
- Upload test uses httpbin.org (may throttle). For production, host your own endpoints.
*/

import React, { useState, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { motion } from "framer-motion";

// Test configuration constants
const TEST_DOWNLOAD_URL = "https://speed.hetzner.de/100MB.bin"; // File to download during the test
const DOWNLOAD_CHUNKS = 3; // How many times to download for averaging
const UPLOAD_SIZE_MB = 5; // Size of random data uploaded for test

export default function InternetSpeedTest() {
  // State values to track test progress and results
  const [running, setRunning] = useState(false);
  const [pingMs, setPingMs] = useState(null);
  const [downloadMbps, setDownloadMbps] = useState(null);
  const [uploadMbps, setUploadMbps] = useState(null);
  const [log, setLog] = useState([]);
  const [chartData, setChartData] = useState([]);
  const controllerRef = useRef(null); // Used to cancel fetch requests

  // Utility: prepend a log message, keeping only last 30
  const addLog = (text) => setLog((l) => [text, ...l].slice(0, 30));

  // Measure Ping by fetching a very small file and timing the round-trip
  async function measurePing() {
    const url = "https://www.google.com/favicon.ico"; // Tiny file, easy to request
    const tries = 4;
    const results = [];
    for (let i = 0; i < tries; i++) {
      const start = performance.now();
      try {
        // HEAD request avoids downloading body, just checks response headers
        await fetch(`${url}?_=${Math.random()}`, { method: "HEAD", cache: "no-store" });
        const delta = performance.now() - start;
        results.push(delta);
        addLog(`Ping attempt ${i + 1}: ${Math.round(delta)} ms`);
      } catch (e) {
        addLog(`Ping attempt ${i + 1}: failed`);
      }
    }
    if (results.length === 0) return null;
    // Use median for stability
    results.sort((a, b) => a - b);
    const median = results[Math.floor(results.length / 2)];
    return Math.round(median);
  }

  // Measure Download speed by reading a large file multiple times
  async function measureDownload() {
    let totalBytes = 0;
    let totalTime = 0;

    controllerRef.current = new AbortController();

    for (let i = 0; i < DOWNLOAD_CHUNKS; i++) {
      const url = `${TEST_DOWNLOAD_URL}?_=${Math.random()}`; // Cache-busting
      addLog(`Starting download ${i + 1} of ${DOWNLOAD_CHUNKS}...`);
      const start = performance.now();
      try {
        const res = await fetch(url, { signal: controllerRef.current.signal });
        const reader = res.body.getReader();
        let bytes = 0;
        while (true) {
          // Read file chunk by chunk
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          // Update live chart data
          setChartData((d) => [
            ...d.slice(0, 99),
            { name: `D${i + 1}:${d.length + 1}`, bytes: Math.round(bytes / 1024) },
          ]);
        }
        const delta = (performance.now() - start) / 1000; // seconds
        totalBytes += bytes;
        totalTime += delta;
        addLog(`Downloaded ${(bytes / 1024 / 1024).toFixed(2)} MB in ${delta.toFixed(2)} s`);
      } catch (e) {
        if (e.name === "AbortError") {
          addLog("Download aborted.");
          throw e;
        }
        addLog(`Download ${i + 1} failed: ${e.message}`);
      }
    }

    if (totalTime <= 0) return null;
    const bits = totalBytes * 8;
    const mbps = (bits / totalTime) / (1024 * 1024);
    return Math.round(mbps * 100) / 100;
  }

  // Measure Upload speed by generating a large random blob and sending it via POST
  async function measureUpload() {
    const size = UPLOAD_SIZE_MB * 1024 * 1024;
    addLog(`Preparing ${UPLOAD_SIZE_MB} MB of upload data...`);

    // Generate random binary data
    const chunk = new Uint8Array(1024 * 100); // 100 KB chunk
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.floor(Math.random() * 256);
    const pieces = Math.ceil(size / chunk.length);
    const arr = new Array(pieces).fill(chunk);
    const blob = new Blob(arr, { type: "application/octet-stream" });

    const uploadUrl = "https://httpbin.org/post"; // Demo endpoint
    const start = performance.now();
    try {
      const res = await fetch(uploadUrl, { method: "POST", body: blob });
      if (!res.ok) throw new Error(`Upload returned ${res.status}`);
      const seconds = (performance.now() - start) / 1000;
      const bits = size * 8;
      const mbps = (bits / seconds) / (1024 * 1024);
      addLog(`Upload finished in ${seconds.toFixed(2)} s`);
      return Math.round(mbps * 100) / 100;
    } catch (e) {
      addLog(`Upload failed: ${e.message}`);
      return null;
    }
  }

  // Orchestrate the full test
  async function runTest() {
    setRunning(true);
    setDownloadMbps(null);
    setUploadMbps(null);
    setPingMs(null);
    setChartData([]);
    addLog("Test started...");
    try {
      const ping = await measurePing();
      setPingMs(ping);
      addLog(`Ping (median): ${ping} ms`);

      const dl = await measureDownload();
      setDownloadMbps(dl);
      addLog(`Download speed: ${dl ?? "failed"} Mbps`);

      const ul = await measureUpload();
      setUploadMbps(ul);
      addLog(`Upload speed: ${ul ?? "failed"} Mbps`);
    } catch (e) {
      addLog(`Test aborted: ${e.message}`);
    } finally {
      setRunning(false);
      controllerRef.current = null;
      addLog("Test finished.");
    }
  }

  // Allow user to stop a running test
  function abortTest() {
    if (controllerRef.current) controllerRef.current.abort();
    setRunning(false);
    addLog("User aborted the test.");
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-white p-6 flex items-start justify-center">
      <div className="w-full max-w-4xl bg-white shadow-2xl rounded-2xl p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Main test controls and results */}
        <div className="md:col-span-2">
          {/* Header and buttons */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl font-extrabold">Internet Speed Test</h1>
              <p className="text-sm text-slate-500">Accurate, browser-based speed check with visual feedback</p>
            </div>
            <div className="space-x-2">
              <button
                disabled={running}
                onClick={runTest}
                className="px-4 py-2 bg-indigo-600 text-white rounded-md shadow hover:scale-105 disabled:opacity-60"
              >
                {running ? "Running..." : "Start Test"}
              </button>
              <button
                onClick={abortTest}
                disabled={!running}
                className="px-4 py-2 border rounded-md hover:bg-slate-50 disabled:opacity-50"
              >
                Abort
              </button>
            </div>
          </div>

          {/* Results cards */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="p-4 bg-slate-50 rounded-lg text-center">
              <div className="text-xs text-slate-500">Ping</div>
              <div className="text-3xl font-bold mt-1">{pingMs ?? "--"} <span className="text-sm">ms</span></div>
            </div>
            <div className="p-4 bg-slate-50 rounded-lg text-center">
              <div className="text-xs text-slate-500">Download</div>
              <div className="text-3xl font-bold mt-1">{downloadMbps ?? "--"} <span className="text-sm">Mbps</span></div>
            </div>
            <div className="p-4 bg-slate-50 rounded-lg text-center">
              <div className="text-xs text-slate-500">Upload</div>
              <div className="text-3xl font-bold mt-1">{uploadMbps ?? "--"} <span className="text-sm">Mbps</span></div>
            </div>
          </div>

          {/* Live chart of download process */}
          <div className="bg-white border rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">Live Download Chart</h3>
              <div className="text-xs text-slate-400">updates per chunk</div>
            </div>
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <XAxis dataKey="name" hide />
                  <YAxis unit="KB" />
                  <Tooltip />
                  <Line type="monotone" dataKey="bytes" stroke="#4f46e5" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Log section */}
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            <h4 className="font-semibold mb-2">Test Log</h4>
            <div className="h-48 overflow-y-auto bg-slate-50 p-3 rounded-lg text-sm">
              {log.length === 0 ? <div className="text-slate-400">No logs yet</div> : null}
              <ul className="space-y-2">
                {log.map((l, i) => (
                  <li key={i} className="leading-snug">{l}</li>
                ))}
              </ul>
            </div>
          </motion.div>
        </div>

        {/* Side panel: explanations and settings */}
        <div className="p-4 border-l md:border-l-0 md:border-l md:border-slate-100">
          <div className="mb-4">
            <h3 className="font-semibold">How this works</h3>
            <ol className="text-sm text-slate-600 list-decimal list-inside mt-2 space-y-1">
              <li>Ping: measures round-trip time to a small resource.</li>
              <li>Download: downloads multiple chunks and measures throughput.</li>
              <li>Upload: generates a blob and POSTs to an endpoint to measure uplink speed.</li>
            </ol>
          </div>

          <div className="mb-4">
            <h3 className="font-semibold">Tips for accurate results</h3>
            <ul className="text-sm text-slate-600 list-disc list-inside mt-2 space-y-1">
              <li>Close other apps that use the network.</li>
              <li>Use a wired connection or place the device near the router.</li>
              <li>Run the test multiple times and take a median.</li>
            </ul>
          </div>

          <div>
            <h3 className="font-semibold">Settings</h3>
            <div className="text-sm text-slate-600 mt-2">
              <div className="flex items-center justify-between py-1">
                <span>Download chunks</span>
                <span className="font-medium">{DOWNLOAD_CHUNKS}</span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span>Upload size</span>
                <span className="font-medium">{UPLOAD_SIZE_MB} MB</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


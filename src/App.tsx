import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from './store';
import {
  Mic,
  MonitorUp,
  Settings,
  X,
  Send,
  User,
  Cpu,
  BrainCircuit,
  Maximize,
  VolumeX,
} from 'lucide-react';

// --- Constants & Config --- //
const WS_URL = 'ws://127.0.0.1:8001/ws/chat';
const API_URL = 'http://127.0.0.1:8001/api';

// --- Main Component --- //
export default function App() {
  const {
    activeSoul,
    setActiveSoul,
    messages,
    addMessage,
    isOverlayMode,
    setOverlayMode,
    isScreenSharing,
    setScreenSharing,
  } = useStore();

  const [input, setInput] = useState('');
  const [showForge, setShowForge] = useState(false);
  const [souls, setSouls] = useState<string[]>(['Sentry']);
  const [recording, setRecording] = useState(false);

  // WebRTC & Audio State
  const ws = useRef<WebSocket | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const currentAudioSource = useRef<HTMLAudioElement | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Sync API & WebSocket
  useEffect(() => {
    // Fetch Souls On Mount
    fetch(`${API_URL}/souls`)
      .then((res) => res.json())
      .then((data) => {
        setSouls(data.souls);
        setActiveSoul(data.active);
      })
      .catch((err) => console.error('Failed to fetch souls:', err));

    // Connect WebSocket
    const connectWS = () => {
      ws.current = new WebSocket(WS_URL);
      ws.current.onopen = () => console.log('🟢 WebSocket connected');
      ws.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'chat_response') {
          addMessage(data.soul, data.message);
        } else if (data.type === 'soul_switched') {
          setActiveSoul(data.soul);
        } else if (data.type === 'audio_stream') {
          playAudio(data.url);
        }
      };
      ws.current.onclose = () => {
        console.log('🔴 WebSocket disconnected. Reconnecting in 3s...');
        setTimeout(connectWS, 3000);
      };
    };
    connectWS();

    return () => ws.current?.close();
  }, []);

  // --- Functions --- //

  // 1. Audio Playback & Interruption
  const playAudio = (url: string) => {
    if (currentAudioSource.current) {
      currentAudioSource.current.pause(); // interrupt current
    }
    const audio = new Audio(url);
    currentAudioSource.current = audio;
    audio.play().catch(console.error);
  };

  const stopAudio = () => {
    if (currentAudioSource.current) {
      currentAudioSource.current.pause();
      currentAudioSource.current.currentTime = 0;
      currentAudioSource.current = null;
      // Send WS signal to abort queue
      if (ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ type: 'audio_interruption' }));
      }
    }
  };

  // 2. Chat Handling
  const sendMessage = (text: string) => {
    if (!text.trim() || ws.current?.readyState !== WebSocket.OPEN) return;
    addMessage('user', text);
    ws.current.send(JSON.stringify({ type: 'chat', message: text }));
    setInput('');
  };

  // 3. Voice Recording (Faster-Whisper)
  const toggleRecording = async () => {
    if (recording && mediaRecorder.current) {
      mediaRecorder.current.stop();
      setRecording(false);
      return;
    }

    try {
      stopAudio(); // Interruption logic: stop playing AI voice when user speaks!
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      audioChunks.current = [];

      mediaRecorder.current.ondataavailable = (event) => {
        audioChunks.current.push(event.data);
      };

      mediaRecorder.current.onstop = async () => {
        const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('audio', audioBlob, 'voice.webm');
        
        // Send to Whisper endpoint
        try {
          const res = await fetch(`${API_URL}/transcribe`, {
            method: 'POST',
            body: formData,
          });
          const data = await res.json();
          if (data.text) {
             sendMessage(data.text);
          }
        } catch (e) {
          console.error("Whisper Error:", e);
        }
      };

      mediaRecorder.current.start();
      setRecording(true);
    } catch (err) {
      console.error('Mic access denied', err);
    }
  };

  // 4. Screen Sharing Capture Loop
  const toggleScreenShare = async () => {
    if (isScreenSharing && screenStream.current) {
      screenStream.current.getTracks().forEach((track) => track.stop());
      screenStream.current = null;
      setScreenSharing(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { max: 5 } }, // Keep low for pulsing
      });
      screenStream.current = stream;
      setScreenSharing(true);

      const videoTrack = stream.getVideoTracks()[0];
      const imageCapture = new (window as any).ImageCapture(videoTrack); // Need polyfill/type tweak for TS but works in latest browsers

      // Start Pulse Loop (Send frames to Phi-4-Vision)
      const pulseLoop = setInterval(async () => {
        if (!screenStream.current) {
          clearInterval(pulseLoop);
          return;
        }
        try {
          const bitmap = await imageCapture.grabFrame();
          const canvas = document.createElement('canvas');
          canvas.width = 640; // Downscale for reasoning speed
          canvas.height = 480;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          
          canvas.toBlob((blob) => {
            if (!blob) return;
            const formData = new FormData();
            formData.append('image', blob, 'screenshot.jpg');
            fetch(`${API_URL}/vision-pulse`, { method: 'POST', body: formData })
               .catch(console.error); // Silent catch to prevent spam
          }, 'image/jpeg', 0.8);
        } catch (e) {
             // Handle stream end
             console.error("Frame grab error:", e);
        }
      }, 5000); // Pulse every 5 seconds for local processing safety

      videoTrack.onended = () => {
        clearInterval(pulseLoop);
        setScreenSharing(false);
      };
    } catch (err) {
      console.error('Screen share Failed', err);
    }
  };

  // --- Render --- //

  // Overlay Mode (OBS Widget Template)
  if (isOverlayMode) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-transparent relative overflow-hidden">
        {/* Transparent UI for OBS overlay */}
        <motion.div 
           initial={{ opacity: 0, scale: 0.8 }}
           animate={{ opacity: 1, scale: 1 }}
           className="bg-[#080809]/80 backdrop-blur-md border border-cyan-500/30 rounded-none p-6 relative flex flex-col gap-6 min-w-[400px]"
        >
          <div className="absolute top-2 right-2 flex space-x-2 z-10">
            <button onClick={stopAudio} className="text-slate-500 hover:text-white transition"><VolumeX size={18} /></button>
            <button onClick={() => setOverlayMode(false)} className="text-slate-500 hover:text-white transition"><Maximize size={18}/></button>
          </div>
          <div className="flex items-center gap-6">
             <div className="w-16 h-16 border-2 border-cyan-400 flex items-center justify-center bg-cyan-900/20 text-cyan-400 font-light text-4xl shadow-[0_0_15px_rgba(34,211,238,0.2)]">
               {activeSoul.charAt(0).toUpperCase()}
             </div>
             <div>
               <h2 className="text-3xl font-black tracking-widest text-white uppercase">{activeSoul}</h2>
               <div className="flex items-center gap-2 mt-1">
                 <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                 <span className="text-[10px] text-cyan-400 font-mono tracking-[0.2em]">TACTICAL LINK ONLINE</span>
               </div>
             </div>
          </div>
          
          <div className="flex flex-col gap-2">
            <AnimatePresence>
               {messages.slice(-1).map((msg, idx) => (
                  <motion.div animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 10 }} key={idx} className="bg-white/5 p-4 border-l-2 border-cyan-400 text-slate-200">
                    <p className="text-sm font-medium tracking-wide line-clamp-3">"{msg.content}"</p>
                  </motion.div>
               ))}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    );
  }

  // Full Dashboard Mode
  return (
    <div className="flex h-screen w-full bg-[#080809] text-slate-200 font-sans p-6 gap-6 overflow-hidden selection:bg-cyan-900">
      
      {/* LEFT: NAVIGATION & SQUAD */}
      <aside className="w-64 flex flex-col gap-6 shrink-0">
        <div className="flex items-center gap-3 px-2">
          <div className="w-10 h-10 bg-cyan-500 rounded-none transform rotate-45 flex items-center justify-center">
            <div className="w-5 h-5 bg-[#080809] transform -rotate-45"></div>
          </div>
          <h1 className="text-2xl font-black tracking-tighter text-white uppercase">Rinoverse</h1>
        </div>
        
        <nav className="flex flex-col gap-1 flex-1">
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold mb-2 px-2">Navigation</div>
          
          <button className="flex items-center gap-3 px-3 py-2 bg-white/5 border-l-2 border-cyan-400 text-cyan-400">
            <span className="w-4 h-4">◈</span> <span className="font-medium text-sm">Command Deck</span>
          </button>
          
          <button 
            onClick={toggleScreenShare}
            className={`flex items-center gap-3 px-3 py-2 transition text-sm ${isScreenSharing ? 'bg-cyan-500/10 text-cyan-400' : 'hover:bg-white/5 text-slate-400'}`}
          >
            <span className="w-4 h-4 text-center">{isScreenSharing ? '◈' : '◇'}</span> 
            <span className="font-medium">Vision Pulse</span>
          </button>
          
          <button 
            onClick={() => setOverlayMode(true)}
            className="flex items-center gap-3 px-3 py-2 hover:bg-white/5 text-slate-400 text-sm transition"
          >
            <span className="w-4 h-4 text-center">◇</span> <span className="font-medium">Hub Module</span>
          </button>

          <button 
            onClick={() => setShowForge(true)}
            className="mt-4 flex items-center gap-3 px-3 py-3 bg-cyan-600/10 border border-cyan-600/30 text-cyan-400 rounded hover:bg-cyan-600/20 transition"
          >
            <span className="text-lg leading-none">+</span> <span className="font-bold text-sm tracking-wide">Forge New Soul</span>
          </button>
        </nav>

        <div className="mt-auto">
          <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold mb-3 px-2">Active Squad</div>
          <div className="flex flex-col gap-2">
            {souls.map(s => {
              const isActive = s === activeSoul;
              return (
                <button 
                  key={s} 
                  onClick={() => {
                    fetch(`${API_URL}/switch-soul`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ soul: s })
                    });
                  }}
                  className={`p-3 text-left w-full transition flex items-center gap-3 ${isActive ? 'bg-white/5 border border-white/10 rounded' : 'border border-transparent hover:border-white/5 opacity-50 hover:opacity-80 rounded'}`}
                >
                  <div className={`w-10 h-10 flex items-center justify-center font-bold ${isActive ? 'bg-cyan-900/50 text-cyan-400' : 'bg-slate-800 text-slate-500'}`}>
                    {s.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div className={`text-sm font-bold ${isActive ? 'text-white' : ''}`}>{s}</div>
                    <div className="text-[10px] uppercase text-slate-500">{isActive ? 'Active' : 'Standby'}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* CENTER: MAIN INTERFACE */}
      <main className="flex-1 flex flex-col gap-6 relative min-w-0">
         
         <header className="h-16 flex items-center justify-between border-b border-white/10 px-4 shrink-0">
          <div className="flex gap-8">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase text-slate-500 font-bold">System Arch</span>
              <span className="text-xs font-mono text-cyan-400 uppercase">FastAPI + RTX 5090</span>
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase text-slate-500 font-bold">Architect</span>
              <span className="text-xs font-mono text-white">Carter</span>
            </div>
          </div>
          <div className="flex gap-4">
            <div className={`px-3 py-1 text-[10px] font-bold border flex items-center gap-2 ${ws.current?.readyState === WebSocket.OPEN ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${ws.current?.readyState === WebSocket.OPEN ? 'bg-green-400' : 'bg-red-400'}`}></div> WEBSOCKET: {ws.current?.readyState === WebSocket.OPEN ? 'CONNECTED' : 'DISCONNECTED'}
            </div>
          </div>
        </header>

         {/* Chat Log */}
         <div className="flex-1 overflow-y-auto space-y-4 scroll-smooth pr-4">
            {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 opacity-50 space-y-4">
                    <div className="text-cyan-400 text-5xl font-light mb-4 animate-pulse">◬</div>
                    <p className="font-mono tracking-widest uppercase text-sm">System initialized. Awaiting input.</p>
                </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                 <div className={`flex max-w-[80%] gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                    
                    <div className={`w-10 h-10 shrink-0 flex items-center justify-center font-bold ${msg.role === 'user' ? 'bg-cyan-600 text-white rounded-none' : 'bg-white/5 border border-white/10 text-cyan-400 rounded-none'}`}>
                        {msg.role === 'user' ? 'C' : activeSoul.charAt(0).toUpperCase()}
                    </div>

                    <div className={`p-4 text-sm font-medium tracking-wide leading-relaxed ${msg.role === 'user' ? 'bg-white/5 border border-white/10 text-slate-200' : 'bg-transparent border-l-2 border-cyan-400 text-slate-300'}`}>
                        {msg.content}
                    </div>

                 </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
         </div>

         {/* Chat Input */}
        <div className="flex gap-4 items-center shrink-0 border-t border-white/10 pt-6">
          <button 
             onClick={toggleRecording}
             className={`w-12 h-12 rounded-none flex items-center justify-center shadow-lg transition-colors shrink-0 ${recording ? 'bg-red-600 shadow-red-900/20 animate-pulse' : 'bg-cyan-600 shadow-cyan-900/20 hover:bg-cyan-500'}`}
          >
             {recording ? <div className="w-4 h-4 bg-white rounded-sm"></div> : <Mic size={20} className="text-white" />}
          </button>
          
          <div className="flex-1 h-12 bg-black/40 border border-white/10 px-4 flex items-center">
            <input 
               type="text" 
               value={input}
               onChange={(e) => setInput(e.target.value)}
               onKeyDown={(e) => e.key === 'Enter' && sendMessage(input)}
               placeholder={`Transmitting to ${activeSoul}...`}
               className="w-full bg-transparent outline-none text-slate-300 placeholder:text-slate-600 text-sm font-mono"
            />
          </div>
          
          <button 
             onClick={() => sendMessage(input)}
             className="w-12 h-12 bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 flex items-center justify-center transition shrink-0"
          >
             <Send size={18} />
          </button>
        </div>
      </main>

      {/* RIGHT: METRICS & AGENTS */}
      <aside className="w-64 flex flex-col gap-6 shrink-0">
        <div className="flex flex-col gap-4">
           <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold px-2">Neural Resources</div>
           
           {/* RTX 5090 STAT */}
           <div className="bg-white/5 border border-white/10 p-3 rounded">
             <div className="flex justify-between text-[10px] mb-1 font-bold">
               <span>GPU LOAD (RTX 5090)</span>
               <span className="text-cyan-400 uppercase">Nominal</span>
             </div>
             <div className="w-full h-1 bg-slate-800">
               <div className="w-1/3 h-full bg-cyan-500"></div>
             </div>
             <div className="mt-2 text-[10px] font-mono text-slate-500">VRAM: 8.4 / 32.0 GB</div>
           </div>

           {/* MODELS */}
           <div className="flex flex-col gap-2">
             <div className="text-[9px] text-slate-500 font-bold uppercase mb-1 px-2">Active Engines</div>
             
             <div className="px-3 py-2 bg-cyan-500/5 border-l border-cyan-500">
               <div className="text-[11px] font-bold text-white uppercase">Qwen 2.5 Instruct</div>
               <div className="text-[9px] text-cyan-400 uppercase">Soul / Personality</div>
             </div>

             <div className="px-3 py-2 bg-white/5">
               <div className="text-[11px] font-bold text-slate-300 uppercase">Phi-4 Vision</div>
               <div className="text-[9px] text-slate-500 uppercase">Visual Analysis</div>
             </div>

             <div className="px-3 py-2 bg-white/5">
               <div className="text-[11px] font-bold text-slate-300 uppercase">Gemini 1.5 Flash</div>
               <div className="text-[9px] text-slate-500 uppercase">Oracle Web Search</div>
             </div>

             <div className="px-3 py-2 bg-white/5">
               <div className="text-[11px] font-bold text-slate-300 uppercase">Kokoro v1.0</div>
               <div className="text-[9px] text-slate-500 uppercase">Voice Synthesis</div>
             </div>
           </div>

           {/* LTM/CHROMA */}
           <div className="mt-4">
             <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold mb-2 px-2">Memory Core</div>
             <div className="p-3 bg-white/5 border border-white/10 rounded">
                <div className="flex items-center justify-between">
                   <span className="text-[10px] text-slate-400 uppercase">ChromaDB Indices</span>
                   <span className="text-[10px] text-white">1,402</span>
                </div>
                <div className="mt-2 text-[9px] text-slate-500 line-clamp-2">
                   Latest entry: "{messages.length > 0 ? messages[messages.length - 1].content : 'System initialized.'}"
                </div>
             </div>
           </div>
        </div>
      </aside>

      {/* Forge Modal */}
      <AnimatePresence>
          {showForge && <ForgeModal onClose={() => setShowForge(false)} onRefresh={() => {
              fetch(`${API_URL}/souls`).then(res => res.json()).then(data => setSouls(data.souls));
          }} />}
      </AnimatePresence>

    </div>
  );
}

// --- Forge Modal Sub-Component --- //
function ForgeModal({ onClose, onRefresh }: { onClose: () => void, onRefresh: () => void }) {
    const [name, setName] = useState('');
    const [prompt, setPrompt] = useState('');
    const [file, setFile] = useState<File | null>(null);

    const submit = async () => {
        const fd = new FormData();
        fd.append('name', name);
        fd.append('prompt', prompt);
        if (file) fd.append('voice_sample', file);
        
        await fetch(`${API_URL}/forge-soul`, { method: 'POST', body: fd});
        onRefresh();
        onClose();
    };

    return (
        <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#080809]/90 backdrop-blur-sm z-50 flex items-center justify-center p-4 font-sans"
        >
            <motion.div 
               initial={{ scale: 0.95, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: -20 }}
               className="bg-[#080809] border border-white/10 rounded-none w-full max-w-xl shadow-2xl relative"
            >
                <div className="absolute top-0 left-0 w-full h-1 bg-cyan-500" />
                <button onClick={onClose} className="absolute top-6 right-6 text-slate-500 hover:text-white"><X size={20}/></button>
                
                <div className="p-8">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-8 h-8 bg-cyan-500/20 border border-cyan-500 flex items-center justify-center text-cyan-500 pb-1 text-2xl font-light">
                        +
                        </div>
                        <h2 className="text-2xl font-black uppercase tracking-tight text-white">Forge Soul</h2>
                    </div>
                    
                    <div className="space-y-6">
                        <div>
                            <label className="text-[10px] font-bold tracking-[0.2em] text-slate-500 block mb-2 uppercase">Designation</label>
                            <input value={name} onChange={e=>setName(e.target.value)} type="text" className="w-full bg-white/5 border border-white/10 px-4 py-3 text-white outline-none focus:border-cyan-500 font-mono text-sm" placeholder="e.g. Commander Shepard" />
                        </div>
                        
                        <div>
                            <label className="text-[10px] font-bold tracking-[0.2em] text-slate-500 block mb-2 uppercase">System Memory (Prompt)</label>
                            <textarea value={prompt} onChange={e=>setPrompt(e.target.value)} rows={4} className="w-full bg-white/5 border border-white/10 px-4 py-3 text-white outline-none focus:border-cyan-500 font-mono resize-none text-sm" placeholder="Define personality traits, logic structures..." />
                        </div>

                        <div>
                            <label className="text-[10px] font-bold tracking-[0.2em] text-slate-500 block mb-2 uppercase">Voice Signature (.WAV/.MP3)</label>
                            <label className="border border-dashed border-white/20 hover:border-cyan-500/50 p-6 text-center cursor-pointer transition bg-white/5 flex flex-col items-center justify-center w-full relative h-32">
                                <input 
                                    type="file" 
                                    accept="audio/*" 
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                    onChange={(e) => {
                                      if (e.target.files && e.target.files.length > 0) {
                                        setFile(e.target.files[0]);
                                      }
                                    }}
                                />
                                <Mic className="text-slate-500 mb-2" size={24} />
                                {file ? (
                                    <p className="text-cyan-400 text-sm font-medium font-mono">{file.name}</p>
                                ) : (
                                    <div className="text-slate-500 text-sm drop-shadow-sm leading-relaxed">Drag or click to upload audio signature<br/><span className="text-[10px] uppercase tracking-widest font-bold opacity-70">Enables dynamic Kokoro TTS synthesis</span></div>
                                )}
                            </label>
                        </div>

                        <div className="mt-8 flex justify-end gap-4">
                            <button onClick={onClose} className="px-6 py-2 border border-white/10 text-slate-400 hover:text-white transition uppercase text-[10px] font-bold tracking-widest">Cancel</button>
                            <button onClick={submit} className="px-6 py-2 bg-cyan-600 text-white hover:bg-cyan-500 transition uppercase text-[10px] font-bold tracking-widest">Initialize Matrix</button>
                        </div>
                    </div>
                </div>
            </motion.div>
        </motion.div>
    );
}

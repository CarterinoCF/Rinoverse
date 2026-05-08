from fastapi import FastAPI, UploadFile, File, BackgroundTasks, Form, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
import asyncio
import os
import uuid
import httpx
import json
import time
import base64
from datetime import datetime
from typing import Optional, List, Dict
from dotenv import load_dotenv
from fastapi.staticfiles import StaticFiles

# Optional dependencies for robust local operation vs AI Studio preview fallback
try:
    import chromadb
    CHROMA_AVAILABLE = True
except ImportError:
    CHROMA_AVAILABLE = False
    print("⚠️ ChromaDB not found. Vector memory will be disabled.")

try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False
    print("⚠️ google.generativeai not found. Oracle will be disabled.")

try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False
    print("⚠️ faster_whisper not found. Audio transcription mocked.")

# 1. INITIALIZE ARMOR & ORACLE
load_dotenv()
GEMINI_KEY = os.getenv("GEMINI_API_KEY")
if GEMINI_AVAILABLE and GEMINI_KEY:
    genai.configure(api_key=GEMINI_KEY)
    print("✅ Sentry Oracle: Gemini API Key Loaded Successfully.")
else:
    print("❌ Sentry Oracle: ERROR - No API Key found or library missing.")

app = FastAPI(title="Rinoverse Tactical Core v3.0")

# Allow dashboard on 3000/3001 to talk to backend on 8001
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 2. DATA MODELS
class ChatMessage(BaseModel):
    message: str
    sessionId: Optional[str] = "default"
    soulId: Optional[str] = "Sentry"

class SoulSwitchRequest(BaseModel):
    soul: str

# 3. PATHS & DIRECTORIES
SOULS_DIR = "./Souls"
RAG_DIR = "./gaming_rag/given_knowledge"
AUDIO_CACHE = "./audio_cache"
os.makedirs(SOULS_DIR, exist_ok=True)
os.makedirs(RAG_DIR, exist_ok=True)
os.makedirs(AUDIO_CACHE, exist_ok=True)

app.mount("/audio_cache", StaticFiles(directory=AUDIO_CACHE), name="audio_cache")

# Set up defaults if empty
default_sentry = os.path.join(SOULS_DIR, "Sentry")
os.makedirs(default_sentry, exist_ok=True)
if not os.path.exists(os.path.join(default_sentry, "persona.txt")):
    with open(os.path.join(default_sentry, "persona.txt"), "w") as f:
        f.write("You are Sentry, a tactical AI assistant optimized for gaming and fast responses. Keep it short and precise.")

# 4. MEMORY & CHROMA DB INITIALIZATION
if CHROMA_AVAILABLE:
    chroma_client = chromadb.PersistentClient(path="./chroma_db")
    memory_collection = chroma_client.get_or_create_collection(name="ltm_memory")
    knowledge_collection = chroma_client.get_or_create_collection(name="given_knowledge")

# 5. GLOBAL STATE & CONNECTIONS
ACTIVE_SOUL = {
    "name": "Sentry", 
    "config": {}, 
    "persona": "", 
    "last_vision": "No visual data yet."
}
SESSION_HISTORY = []
active_connections: List[WebSocket] = []

def load_soul(soul_name: str):
    soul_path = os.path.join(SOULS_DIR, soul_name)
    if not os.path.exists(soul_path): return False
    config_path = os.path.join(soul_path, "config.json")
    persona_path = os.path.join(soul_path, "persona.txt")
    
    try:
        with open(config_path, "r") as f: config = json.load(f)
    except:
        config = {}
        
    try:
        with open(persona_path, "r") as f: persona = f.read()
    except:
        persona = "You are a helpful AI."
        
    global ACTIVE_SOUL
    ACTIVE_SOUL["name"] = soul_name
    ACTIVE_SOUL["config"] = config
    ACTIVE_SOUL["persona"] = persona
    return True

load_soul("Sentry")

# WEBSOCKET MANAGER
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            await connection.send_json(message)

manager = ConnectionManager()

# WHISPER INIT
whisper_model = None
if WHISPER_AVAILABLE:
    # Use small model for fast RT processing locally. For 5090, large-v3 could be used but small is near instant.
    print("⏳ Loading Faster-Whisper Model...")
    whisper_model = WhisperModel("base", device="cuda" if os.environ.get("USE_CUDA", "False") == "True" else "cpu", compute_type="float16" if os.environ.get("USE_CUDA", "False") == "True" else "int8")
    print("✅ Whisper Loaded.")

# 6. ENDPOINTS

@app.get("/api/souls")
async def get_souls():
    souls = [d for d in os.listdir(SOULS_DIR) if os.path.isdir(os.path.join(SOULS_DIR, d))]
    if not souls: souls = ["Sentry"]
    return {"souls": souls, "active": ACTIVE_SOUL["name"]}

@app.post("/api/switch-soul")
async def switch_soul(req: SoulSwitchRequest):
    success = load_soul(req.soul)
    if success:
        # Notify connected clients
        await manager.broadcast({"type": "soul_switched", "soul": req.soul})
        return {"status": "success", "active": req.soul}
    return {"status": "error", "message": "Soul not found."}

@app.post("/api/forge-soul")
async def forge_soul(name: str = Form(...), prompt: str = Form(...), voice_sample: UploadFile = File(None)):
    soul_dir = os.path.join(SOULS_DIR, name)
    os.makedirs(soul_dir, exist_ok=True)
    
    with open(os.path.join(soul_dir, "persona.txt"), "w") as f:
        f.write(prompt)
        
    with open(os.path.join(soul_dir, "config.json"), "w") as f:
        json.dump({"created_at": str(datetime.now())}, f)
        
    if voice_sample:
        # Save sample for voice cloning logic
        content = await voice_sample.read()
        with open(os.path.join(soul_dir, "voice.wav"), "wb") as f:
            f.write(content)
            
    # Auto switch
    load_soul(name)
    await manager.broadcast({"type": "soul_switched", "soul": name})
    return {"status": "success", "soul": name}

@app.post("/api/upload-knowledge")
async def upload_knowledge(file: UploadFile = File(...)):
    contents = await file.read()
    filename = file.filename
    file_path = os.path.join(RAG_DIR, filename)
    
    with open(file_path, "wb") as f:
        f.write(contents)
        
    # In a real pipeline, we extract text (pdf/txt) and embed via Chroma DB
    if CHROMA_AVAILABLE:
        doc_id = str(uuid.uuid4())
        # Simplified string version. For PDFs you'd use pypdf or similar.
        text_content = contents.decode('utf-8', errors='ignore')[:1000] 
        knowledge_collection.add(
            documents=[text_content],
            metadatas=[{"source": filename}],
            ids=[doc_id]
        )
    return {"status": "success", "message": "Knowledge added to RAG."}

@app.post("/api/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    contents = await audio.read()
    filepath = f"{AUDIO_CACHE}/temp_{uuid.uuid4()}.webm"
    with open(filepath, "wb") as f:
        f.write(contents)
        
    if whisper_model:
        segments, _ = whisper_model.transcribe(filepath, beam_size=5)
        text = "".join([segment.text for segment in segments])
    else:
        text = "Simulated voice transcription. Faster-whisper not installed."
        
    # Cleanup temp file
    if os.path.exists(filepath):
        os.remove(filepath)
        
    return {"text": text.strip()}

@app.post("/api/vision-pulse")
async def vision_pulse(image: UploadFile = File(...)):
    contents = await image.read()
    filename = f"pulse_{int(time.time())}.jpg"
    with open(os.path.join(RAG_DIR, filename), "wb") as f:
        f.write(contents)
    
    try:
        base64_image = base64.b64encode(contents).decode('utf-8')
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "http://localhost:1234/v1/chat/completions",
                json={
                    "model": "phi-4-reasoning-vision-15b", # Adjust based on LM Studio alias
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "Tactical summary: What are you seeing right now?"},
                                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}}
                            ]
                        }
                    ],
                    "temperature": 0.1
                },
                timeout=15.0
            )
            analysis = response.json()["choices"][0]["message"]["content"]
            ACTIVE_SOUL["last_vision"] = analysis
            return {"status": "processed", "summary": analysis}
    except Exception:
        # Fallback if local LM studio vision is offline
        ACTIVE_SOUL["last_vision"] = "User's screen is currently streaming game data."
        return {"status": "error", "summary": "Vision Engine (Port 1234) Offline."}


# 7. WEBSOCKET CHAT PROCESSOR (QWEN-2.5 & KOKORO TTS)
@app.websocket("/ws/chat")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            
            if payload.get("type") == "audio_interruption":
                print("🛑 User interrupted! Clearing TTS queue.")
                # We handle state logic client-side primarily, but could abort active tasks here
                continue

            user_query = payload.get("message", "")
            if not user_query: continue
            
            # Send immediate acknowledgment
            await manager.broadcast({"type": "chat_ack", "message": user_query})
            
            SESSION_HISTORY.append({"role": "user", "message": user_query})
            vision_context = ACTIVE_SOUL.get("last_vision", "No visual data yet.")
            
            use_cloud = any(word in user_query.lower() for word in ["search", "update", "patch", "news", "oracle"])
            response_text = ""

            # 1. ORACLE / DEEP WEB PIPELINE
            if use_cloud and GEMINI_KEY:
                try:
                    model = genai.GenerativeModel('gemini-1.5-flash')
                    oracle_prompt = f"SYSTEM: {ACTIVE_SOUL['persona']}\nVISION: {vision_context}\nQUERY: {user_query}"
                    gemini_res = model.generate_content(oracle_prompt)
                    response_text = f"[ORACLE INSIGHT] {gemini_res.text}"
                except Exception as e:
                    print(f"Oracle Error: {e}")

            # 2. LOCAL QWEN WITH TOOL CALLING
            if not response_text:
                system_prompt = f"""{ACTIVE_SOUL['persona']}

CRITICAL DIRECTIVE: You CAN see. I am feeding you a live visual feed. 
CURRENT VISUAL FEED DATA: "{vision_context}"

If the user asks to switch to another soul/agent (like 'switch to Olivia' or 'bring in Ghost'), YOU MUST USE the 'switch_active_soul' tool.
"""
                messages = [{"role": "system", "content": system_prompt}]
                for m in SESSION_HISTORY[-6:]: # Keep context window reasonable
                    messages.append({"role": "assistant" if m["role"] == "sentry" else "user", "content": m["message"]})
                
                tools = [
                    {
                        "type": "function",
                        "function": {
                            "name": "switch_active_soul",
                            "description": "Switches the active persona/soul to a different character.",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "target_soul": {
                                        "type": "string",
                                        "description": "The name of the new soul to switch to (e.g. Sentry, Olivia, Ghost)"
                                    }
                                },
                                "required": ["target_soul"]
                            }
                        }
                    }
                ]

                try:
                    async with httpx.AsyncClient() as client:
                        # Request with tools to Qwen locally
                        res = await client.post("http://127.0.0.1:1234/v1/chat/completions",
                            json={
                                "model": "qwen2.5-7b-instruct-uncensored", 
                                "messages": messages, 
                                "temperature": 0.7,
                                "tools": tools
                            }, timeout=30.0)
                        
                        response_data = res.json()["choices"][0]["message"]
                        
                        # Handle Tool Call for Soul Switching
                        if "tool_calls" in response_data and response_data["tool_calls"]:
                            tool_call = response_data["tool_calls"][0]
                            if tool_call["function"]["name"] == "switch_active_soul":
                                args = json.loads(tool_call["function"]["arguments"])
                                target_soul = args.get("target_soul", "")
                                
                                success = load_soul(target_soul)
                                if success:
                                    response_text = f"Switching tactical feed to {target_soul}..."
                                    await manager.broadcast({"type": "soul_switched", "soul": target_soul})
                                else:
                                    response_text = f"Attempted to switch to {target_soul}, but soul data was missing."
                        else:
                            response_text = response_data.get("content", "")
                except Exception as e:
                    response_text = "Local LM Studio offline. Check port 1234."

            SESSION_HISTORY.append({"role": "sentry", "message": response_text})

            # Save interaction to LTM (ChromaDB)
            if CHROMA_AVAILABLE:
                memory_collection.add(
                    documents=[f"User: {user_query}\n{ACTIVE_SOUL['name']}: {response_text}"],
                    metadatas=[{"soul": ACTIVE_SOUL["name"], "timestamp": str(datetime.now())}],
                    ids=[str(uuid.uuid4())]
                )

            # Send Chat Response
            await manager.broadcast({"type": "chat_response", "message": response_text, "soul": ACTIVE_SOUL["name"]})

            # 3. KOKORO TTS AUDIO GENERATION
            # If Kokoro API is running, generate audio and send URL
            audio_url = None
            try:
                # We request audio from local Kokoro or equivalent TTS 
                async with httpx.AsyncClient() as client:
                    tts_res = await client.post("http://localhost:50000/v1/audio/speech",
                        json={
                            "input": response_text,
                            "voice": "af_heart", # Example Kokoro voice 
                            "response_format": "mp3"
                        }, timeout=10.0)
                    
                    if tts_res.status_code == 200:
                        audio_id = f"{uuid.uuid4()}.mp3"
                        full_path = os.path.join(AUDIO_CACHE, audio_id)
                        with open(full_path, "wb") as f:
                            f.write(tts_res.content)
                        # Assumes backend running on 8001
                        audio_url = f"http://localhost:8001/audio_cache/{audio_id}"
            except Exception: 
                # Provide fallback for local RTX demo if TTS endpoint offline
                pass
            
            if audio_url:
                await manager.broadcast({"type": "audio_stream", "url": audio_url})

    except WebSocketDisconnect:
        manager.disconnect(websocket)
        print("Client disconnected.")
    except Exception as e:
        manager.disconnect(websocket)
        print(f"WS Error: {e}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)

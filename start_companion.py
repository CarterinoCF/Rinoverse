import os
import subprocess
import sys
import time
from threading import Thread

def run_backend():
    print("🚀 Starting FastAPI Backend (Rinoverse)...")
    subprocess.run([sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8001"])

def run_frontend():
    print("🌐 Starting React Frontend...")
    # Assuming standard npm run dev
    subprocess.run(["npm", "run", "dev"], shell=os.name == 'nt')

if __name__ == "__main__":
    print("✨ Booting up Rinoverse AI Companion Master Script ✨")
    
    # Initialize directories necessary for the app to function properly
    dirs = ["./Souls", "./audio_cache", "./gaming_rag/given_knowledge"]
    for d in dirs:
        os.makedirs(d, exist_ok=True)
        print(f"📁 Verified directory: {d}")
        
    # Start processes
    backend_thread = Thread(target=run_backend)
    frontend_thread = Thread(target=run_frontend)
    
    backend_thread.start()
    time.sleep(2) # Wait to ensure backend binds to port first
    frontend_thread.start()
    
    backend_thread.join()
    frontend_thread.join()

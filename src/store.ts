import { create } from 'zustand';

interface AppState {
  activeSoul: string;
  setActiveSoul: (soul: string) => void;
  messages: Array<{ role: string; content: string }>;
  addMessage: (role: string, content: string) => void;
  isOverlayMode: boolean;
  setOverlayMode: (isOverlay: boolean) => void;
  isScreenSharing: boolean;
  setScreenSharing: (isSharing: boolean) => void;
  isVADActive: boolean;
  setVADActive: (isActive: boolean) => void;
}

export const useStore = create<AppState>((set) => ({
  activeSoul: 'Sentry',
  setActiveSoul: (soul) => set({ activeSoul: soul }),
  messages: [],
  addMessage: (role, content) =>
    set((state) => ({
      messages: [...state.messages, { role, content }],
    })),
  isOverlayMode: false,
  setOverlayMode: (isOverlay) => set({ isOverlayMode: isOverlay }),
  isScreenSharing: false,
  setScreenSharing: (isSharing) => set({ isScreenSharing: isSharing }),
  isVADActive: false,
  setVADActive: (isActive) => set({ isVADActive: isActive }),
}));

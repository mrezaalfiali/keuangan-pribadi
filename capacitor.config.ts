import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mohrezaaanexora.app',
  appName: 'Nexora',
  webDir: 'www',
  server: {
    url: 'https://keuangan-pribadi-m4vp.vercel.app',
    cleartext: false
  }
};

export default config;
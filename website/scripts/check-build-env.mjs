import {loadEnv} from 'vite';
const env = {...loadEnv('production',process.cwd(), 'VITE_'), ...process.env};
const required = ['VITE_FIREBASE_API_KEY','VITE_FIREBASE_AUTH_DOMAIN','VITE_FIREBASE_PROJECT_ID','VITE_FIREBASE_APP_ID','VITE_BOXIE_MICROSOFT_CLIENT_ID','VITE_BOXIE_PUBLIC_REGISTRATION','VITE_BOXIE_ORGANIZATION_SYNC_V2'];
for (const key of required) if(!env[key]?.trim()) throw new Error(`Missing production build configuration: ${key}`);
for (const key of ['VITE_BOXIE_AUTH_EMULATOR_HOST','VITE_BOXIE_FIRESTORE_EMULATOR_HOST']) if(env[key]) throw new Error(`Emulator configuration is forbidden in production: ${key}`);
if(env.VITE_BOXIE_SPIKE_ALLOW_EMULATOR_IDENTITY==='true') throw new Error('Synthetic identity is forbidden in production');
for(const key of ['VITE_BOXIE_PUBLIC_REGISTRATION','VITE_BOXIE_ORGANIZATION_SYNC_V2']) if(!['true','false'].includes(env[key])) throw new Error(`Expected explicit boolean: ${key}`);
console.log('Production browser configuration validated.');

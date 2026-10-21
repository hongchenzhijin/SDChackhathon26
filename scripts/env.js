// Loads .env (if present) before any other module reads process.env. Replit Secrets need no file.
try { process.loadEnvFile?.(); } catch { /* no .env file: fine */ }

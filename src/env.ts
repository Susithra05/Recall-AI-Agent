// Import this first: it loads .env before any other module reads process.env.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

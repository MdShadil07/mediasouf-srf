/**
 * env.js — Must be the FIRST import in server.js.
 * In ESM, all `import` statements are hoisted and resolved before any code runs.
 * This means dotenv.config() in server.js runs AFTER all imports are loaded,
 * so module-level process.env reads in other files see undefined.
 *
 * By placing dotenv.config() here and importing this file first,
 * we ensure env vars are populated before any other module reads them.
 */
import dotenv from 'dotenv';
dotenv.config();

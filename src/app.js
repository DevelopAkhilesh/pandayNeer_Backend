import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import authRoutes from './modules/auth/auth.routes.js';
const app = express();

// Comma-separated so staging/preview origins can be added without a code
// change. Bare cors() defaulted to allow-all and ignored CORS_ORIGIN entirely,
// leaving a required env var doing nothing.
const allowedOrigins = env.CORS_ORIGIN.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet());
// Clients that send no Origin header — the mobile app, curl, server-to-server
// — are unaffected: CORS is enforced by the browser, not here.
app.use(cors({ origin: allowedOrigins }));
app.use(morgan('dev'));
app.use(express.json());
app.set('trust proxy', 1)

app.get('/', (req, res) => {
  res.json({ message: 'pandeyNeer API is running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.use('/api/auth', authRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

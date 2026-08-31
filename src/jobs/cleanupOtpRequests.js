import cron from 'node-cron';
import { prisma } from '../config/db.js';

// Anything older than this is safe to delete regardless of status —
// OTPs are only ever valid for 5 minutes, so a day-old row has long
// since served its purpose either way (used, expired, or abandoned).
const RETENTION_HOURS = 24;

async function cleanupOldOtpRequests() {
  const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000);

  try {
    const result = await prisma.otpRequest.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    if (result.count > 0) {
      console.log(`🧹 Cleaned up ${result.count} old OTP request(s)`);
    }
  } catch (err) {
    console.error('❌ OTP cleanup job failed:', err);
  }
}

export function startOtpCleanupJob() {
  // Runs once every hour, on the hour.
  cron.schedule('0 * * * *', cleanupOldOtpRequests);
  console.log('🕐 OTP cleanup job scheduled (runs hourly)');
}
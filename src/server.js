import 'dotenv/config';
import app from './app.js';
import { warmDbPool } from './config/db.js';
import { smsProviderName } from './services/sms/sms.provider.js';
import { startOtpCleanupJob } from './jobs/cleanupOtpRequests.js';

const PORT = process.env.PORT || 5050;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Stated plainly at boot. Silent console mode is how a deploy ends up
  // reporting "OTP sent successfully" for messages nobody ever receives.
  if (smsProviderName === 'console') {
    console.log('SMS: console mode — OTPs print here, nothing is delivered');
  } else {
    console.log(`SMS: sending live via ${smsProviderName}`);
  }

  startOtpCleanupJob();
  // Fire-and-forget: a cold pool only makes the first request slow, so this
  // must not stop the server from coming up.
  warmDbPool().catch((err) =>
    console.error('DB warm-up failed:', err.message)
  );
});

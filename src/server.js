import 'dotenv/config';
import app from './app.js';
import { warmDbPool } from './config/db.js';
import { smsProviderName } from './services/sms/sms.provider.js';
import { startOtpCleanupJob } from './jobs/cleanupOtpRequests.js';
import { primeServiceAreaCache } from './modules/service-areas/service-areas.cache.js';

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
  warmDbPool()
    .then(() =>
      // Only after the pool is warm — priming on a cold pool would just pay
      // the ~490ms handshake here instead of in the first request.
      primeServiceAreaCache().catch((err) =>
        console.error('Service area cache prime failed:', err.message)
      )
    )
    .catch((err) => console.error('DB warm-up failed:', err.message));
});

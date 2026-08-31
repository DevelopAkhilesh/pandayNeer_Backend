import 'dotenv/config';
import app from './app.js';
import { startOtpCleanupJob } from './jobs/cleanupOtpRequests.js';

const PORT = process.env.PORT || 5050;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startOtpCleanupJob();
});

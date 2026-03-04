const { authorize } = require('../src/google-auth');

(async () => {
  try {
    await authorize();
    console.log('Google OAuth2 setup complete!');
  } catch (err) {
    console.error('Auth failed:', err.message);
    process.exit(1);
  }
})();

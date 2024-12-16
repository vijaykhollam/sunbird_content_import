export default () => ({
  middlewareUrl: process.env.MIDDLEWARE_QA_URL || 'http://default-url',
  port: parseInt(process.env.PORT || '3000', 10),
});
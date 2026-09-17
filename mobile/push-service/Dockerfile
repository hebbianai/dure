FROM node:24.15.0-bookworm-slim
WORKDIR /app
# The sender uses the same canonical messages as the phone. No dependency
# installation, application credentials, or terminal state enters the image.
COPY mobile/push-service/apns.mjs mobile/push-service/main.mjs mobile/push-service/service.mjs mobile/push-service/
COPY mobile/src/locales/en.ts mobile/src/locales/ko.ts mobile/src/locales/
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "mobile/push-service/main.mjs"]

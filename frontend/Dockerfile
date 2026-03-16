FROM node:18-alpine AS build

WORKDIR /app

# 只处理 package.json / package-lock.json，避免 Dockerfile 中使用 shell 重定向导致报错
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]


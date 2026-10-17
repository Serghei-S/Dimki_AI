# Простой запуск на сервере по IP

Для Ubuntu/Debian x86-64. Один Node-процесс отдаёт сайт и AI API; домен, HTTPS, Nginx и архивы не нужны.
Использовать последнюю `main`, содержащую `scripts/serve.mjs` и команду `pnpm start`, а не старый a9726e7.

## 1. Установить инструменты

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates nano
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm@11.25.0
```

Если Node.js 24 и pnpm уже установлены, этот шаг пропустить.

## 2. Скачать проект

```bash
git clone https://github.com/Serghei-S/Dimki_AI.git
cd Dimki_AI
pnpm install --frozen-lockfile
cp .env.example .env.local
nano .env.local
```

В `.env.local` указать адрес сервера и **тот же действующий API-ключ RiskRadar**:

```dotenv
PUBLIC_ORIGIN=http://ВАШ_IP:4173
PORT=4173
AI_PROVIDER=riskradar
RISKRADAR_API_KEY=ВАШ_ДЕЙСТВУЮЩИЙ_КЛЮЧ
RISKRADAR_MODEL=gemini-2.5-flash
```

Заменить `ВАШ_IP`, например на `203.0.113.10`, и ключ. Удалить прежнюю строку `AI_PROVIDER=openrouter`,
если она осталась из примера: каждую переменную записывать один раз. Без `/` в конце PUBLIC_ORIGIN.
Сохранить nano: Ctrl+O, Enter, Ctrl+X. Файл `.env.local` игнорируется Git и не раздаётся браузеру.

## 3. Собрать и запустить

```bash
pnpm build
nohup pnpm start > /tmp/dimki-ai.log 2>&1 < /dev/null &
```

Дождаться успешной сборки. Открыть **TCP 4173** в панели сервера/облачном firewall.
Если используется включённый UFW: `sudo ufw allow 4173/tcp`. Включать UFW для запуска не требуется.

Открыть `http://ВАШ_IP:4173/`. Процесс продолжает работать после закрытия SSH.
Для запуска в текущем терминале вместо nohup достаточно `pnpm start`.
После перезагрузки самого сервера повторить команду nohup или настроить менеджер процессов.

Карта и расчёты работают без ключа; для AI нужен действующий ключ с доступной квотой и исходящий HTTPS к RiskRadar.
Новый сервер сохраняет проверку Host/Origin и общие AI-лимиты. Настройка PUBLIC_ORIGIN разрешает именно указанный адрес.
Настоящий ключ не нужно писать в клиентские переменные `VITE_*` или отправлять в GitHub.

## Если не открылось

```bash
tail -n 80 /tmp/dimki-ai.log
curl -sS http://ВАШ_IP:4173/api/assistant/status
```

`configured: true` означает, что сервер видит ключ, но не проверяет баланс шлюза.
Проверить реальный AI можно одним вопросом в окне «Отчёт».
Если локальный curl работает, а снаружи нет — проверить внешний IP и доступ к порту 4173 в панели хостинга.
Если `EADDRINUSE` — на этом порту уже работает процесс; не запускать второй экземпляр.
Если API отвечает 403 — адрес в PUBLIC_ORIGIN должен точно совпадать с адресом браузера, включая порт.

## Обновить

Остановить предыдущий экземпляр перед новой сборкой/запуском, чтобы не оставить старый API в памяти.
Затем в каталоге проекта:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
nohup pnpm start > /tmp/dimki-ai.log 2>&1 < /dev/null &
```

Для регулярного обновления удобнее PM2 или systemd; для разового запуска по IP они не обязательны.

Техническая совместимость HTTP: отпечатки данных считаются SHA-256 без обязательного WebCrypto;
UUID создаются через доступный на HTTP getRandomValues. Числа расчёта и идентификатор набора данных сохраняются.

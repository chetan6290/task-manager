# Taskboard

Task manager with sign-in, task CRUD and live updates.
Stack: Node.js, Express, MySQL, JWT, Socket.IO, plain HTML/CSS/JS.

## Run it
1. `npm install`
2. Create the database: `mysql -u root -p < schema.sql`
3. `cp .env.example .env` and fill in your MySQL password and a long random `JWT_SECRET`
4. `npm start`, then open http://localhost:3000

## How it fits together
- `server.js`: REST API (`/api/auth/*`, `/api/tasks`), JWT middleware, Socket.IO rooms (one per user)
- `schema.sql`: `users` and `tasks` tables; tasks belong to a user (foreign key)
- `public/app.js`: calls the API with `fetch`, listens for `task:upsert` / `task:delete` socket events and re-renders

## API
| Method | Path | Purpose |
|---|---|---|
| POST | /api/auth/register | Create account, returns token |
| POST | /api/auth/login | Sign in, returns token |
| GET | /api/tasks | List your tasks |
| POST | /api/tasks | Create a task |
| PUT | /api/tasks/:id | Update any task fields (title, description, status, priority, due_date) |
| DELETE | /api/tasks/:id | Delete a task |

Send `Authorization: Bearer <token>` on every `/api/tasks` call.

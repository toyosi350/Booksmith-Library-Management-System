# Booksmith LMS

A command-line Library Management System built with Node.js and MongoDB.

## Features
- User registration and login
- Admin-only book creation, update, and deletion
- Search books
- Purchase books
- Rent and return books
- View personal shelf and transaction history
- Password change
- Auto-return for overdue rentals

## Tech Stack
- Node.js
- MongoDB
- bcrypt
- readline-sync
- uuid
- dotenv

## Setup
1. Clone the repository
2. Run `npm install`
3. Create a `.env` file based on `.env.example`
4. Start local MongoDB
5. Run the project

## Environment Variables
- `ADMIN_USERNAME`
- `MONGODB_URI`

## Run
```bash
node lms.mjs

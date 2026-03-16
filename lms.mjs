import "dotenv/config";
import readlineSync from "readline-sync";
import { MongoClient, ObjectId } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";

const now = () => new Date();
const normalize_str = (s) => s.trim().split(/\s+/).join(" ");

const confirm = (prompt = "Are you sure? (y/n): ") => {
  const ans = readlineSync.question(prompt).trim().toLowerCase();
  return ans === "y" || ans === "yes";
};

let currentUser = null;

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "toyosi350").trim().toLowerCase();

const print_line = () => console.log("-".repeat(64));

const out_of_stock_label = (copies) =>
  copies <= 0 ? "Out of Stock" : `${copies} available`;

const canonical_book_key = (name, authors, year, tags, price, synopsis) => {
  const nm = normalize_str(name).toLowerCase();
  const syn = normalize_str(synopsis || "").toLowerCase();
  const auths = authors.map(a => normalize_str(a).toLowerCase()).sort();
  const tgs = tags.map(t => normalize_str(t).toLowerCase()).sort();
  return [nm, auths, parseInt(year), tgs, parseFloat(price), syn];
};

(async () => {
  console.log("📘 Booksmith LMS starting...");

  const CLUSTER_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
  const client = new MongoClient(CLUSTER_URI);

  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB");

    const db = client.db("lms");

    const booksCol = db.collection("books");
    const authorsCol = db.collection("authors");
    const tagsCol = db.collection("tags");
    const yearsCol = db.collection("years");
    const usersCol = db.collection("users");
    const transactionsCol = db.collection("transactions");

    function require_login() {
      if (!currentUser) {
        console.log("❌ Please login first.");
        return false;
      }
      return true;
    }

    function is_admin() {
      return currentUser?.role === "admin";
    }

    function require_admin() {
      if (!currentUser) {
        console.log("❌ Please login first.");
        return false;
      }
      if (currentUser.role !== "admin") {
        console.log("⛔ Admin only.");
        return false;
      }
      return true;
    }

    const ensure_author = async (name) => {
      const nm = normalize_str(name);
      if (!await authorsCol.findOne({ name: nm })) {
        await authorsCol.insertOne({ name: nm, created_at: now() });
      }
    };

    const ensure_tag = async (name) => {
      const nm = normalize_str(name);
      if (!await tagsCol.findOne({ name: nm })) {
        await tagsCol.insertOne({ name: nm, created_at: now() });
      }
    };

    const ensure_year = async (y) => {
      y = parseInt(y);
      if (!await yearsCol.findOne({ value: y })) {
        await yearsCol.insertOne({ value: y, created_at: now() });
      }
    };

    const ensure_user = async (username) => {
      const uname = normalize_str(username);
      let user = await usersCol.findOne({ username: uname });

      if (!user) {
        await usersCol.insertOne({
          username: uname,
          password_hash: null,
          role: "user",
          rentals: [],
          purchases: [],
          created_at: now(),
          updated_at: now()
        });
        user = await usersCol.findOne({ username: uname });
      }

      return user;
    };

    const record_transaction = async (type, username, books, due_date = null, note = null) => {
      const trx = {
        transaction_id: uuidv4(),
        type,
        username: normalize_str(username),
        items: books.map(b => ({
          book_id: b._id,
          book_name: b.name,
          price: b.price ?? null
        })),
        date: now(),
        due_date,
        note: note || "Transaction completed!!"
      };
      await transactionsCol.insertOne(trx);
      return trx;
    };

    const print_book = (b, idx) => {
      const prefix = idx ? `[${idx}] ` : "";
      const tags = b.tags?.join(", ") || "-";
      const authors = b.authors?.join(", ") || "-";
      const status = out_of_stock_label(b.copies || 0);

      console.log(`${prefix}${b.name} — ${authors} (${b.year}) | ₦${b.price} | ${status}`);
      console.log(`   Tags: ${tags}`);

      if (b.synopsis) {
        console.log(`   Synopsis: ${b.synopsis.slice(0, 140)}${b.synopsis.length > 140 ? "..." : ""}`);
      }
    };

    const auto_return_overdues = async (username) => {
      const user = await ensure_user(username);
      const rentals = user.rentals || [];
      const kept = [];
      const returnedBooks = [];

      for (const r of rentals) {
        const due = new Date(r.due_date);

        if (now() > due) {
          const bookId = typeof r.book_id === "string" ? new ObjectId(r.book_id) : r.book_id;
          const bk = await booksCol.findOne({ _id: bookId });

          if (bk) {
            await booksCol.updateOne(
              { _id: bk._id },
              { $inc: { copies: 1 }, $set: { updated_at: now() } }
            );
            returnedBooks.push(bk);
          }
        } else {
          kept.push(r);
        }
      }

      if (kept.length !== rentals.length) {
        await usersCol.updateOne(
          { _id: user._id },
          { $set: { rentals: kept, updated_at: now() } }
        );

        if (returnedBooks.length) {
          await record_transaction("return", username, returnedBooks, null, "Auto-return on due date");
          console.log("ℹ️ Some rentals reached their due date and were auto-returned.");
        }
      }

      return await usersCol.findOne({ username: normalize_str(username) });
    };

    const register_user = async () => {
      print_line();
      console.log("🆕 Register");

      const username = normalize_str(readlineSync.question("Choose username: "));
      const password = readlineSync.question("Choose password: ", { hideEchoBack: true });

      if (!username || !password) {
        console.log("❌ Username and password required.");
        return null;
      }

      if (password.length < 6) {
        console.log("❌ Password must be at least 6 characters.");
        return null;
      }

      const existing = await usersCol.findOne({ username });
      if (existing) {
        console.log("❌ Username already exists. Try another.");
        return null;
      }

      const password_hash = await bcrypt.hash(password, 12);
      const role = username.toLowerCase() === ADMIN_USERNAME ? "admin" : "user";

      await usersCol.insertOne({
        username,
        password_hash,
        role,
        rentals: [],
        purchases: [],
        created_at: now(),
        updated_at: now()
      });

      console.log(
        role === "admin"
          ? "✅ Account created. Admin access granted."
          : "✅ Account created."
      );

      return await usersCol.findOne({ username });
    };

    const login_user = async () => {
      print_line();
      console.log("🔐 Login");

      const username = normalize_str(readlineSync.question("Username: "));
      const password = readlineSync.question("Password: ", { hideEchoBack: true });

      const user = await usersCol.findOne({ username });

      if (!user || !user.password_hash) {
        console.log("❌ Invalid username or user has no password yet.");
        return null;
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        console.log("❌ Wrong password.");
        return null;
      }

      const refreshedUser = await auto_return_overdues(username);

      console.log(`✅ Logged in as ${username}`);
      return refreshedUser;
    };

    const change_password = async () => {
      if (!currentUser) {
        console.log("❌ You must be logged in to change your password.");
        return;
      }

      print_line();
      console.log("🔑 Change Password");

      const oldPw = readlineSync.question("Current password: ", { hideEchoBack: true });
      const user = await usersCol.findOne({ username: currentUser.username });

      if (!user?.password_hash) {
        console.log("❌ This account has no password set yet.");
        return;
      }

      const ok = await bcrypt.compare(oldPw, user.password_hash);
      if (!ok) {
        console.log("❌ Current password is incorrect.");
        return;
      }

      const newPw = readlineSync.question("New password: ", { hideEchoBack: true });
      const newPw2 = readlineSync.question("Confirm new password: ", { hideEchoBack: true });

      if (!newPw || newPw.length < 6) {
        console.log("❌ Password must be at least 6 characters.");
        return;
      }

      if (newPw !== newPw2) {
        console.log("❌ Passwords do not match.");
        return;
      }

      const newHash = await bcrypt.hash(newPw, 12);

      await usersCol.updateOne(
        { _id: user._id },
        { $set: { password_hash: newHash, updated_at: now() } }
      );

      console.log("✅ Password changed successfully.");
      currentUser = null;
      console.log("🔒 Please login again.");
      await start_session();
    };

    const start_session = async () => {
      while (true) {
        print_line();
        console.log("👤 Welcome to Booksmith");
        console.log("  1) Login");
        console.log("  2) Register");
        console.log("  3) Continue without account");

        const choice = readlineSync.question("Choose (1-3): ").trim();

        if (choice === "1") {
          const u = await login_user();
          if (u) {
            currentUser = u;
            return;
          }
        } else if (choice === "2") {
          const u = await register_user();
          if (u) {
            currentUser = await auto_return_overdues(u.username);
            return;
          }
        } else if (choice === "3") {
          currentUser = null;
          return;
        } else {
          console.log("Invalid choice.");
        }
      }
    };

    const search_books = async () => {
      print_line();
      console.log("🔎 Search Books");

      const q_name = normalize_str(readlineSync.question("Book Name (partial ok): "));
      const q_author = normalize_str(readlineSync.question("Author (partial ok): "));
      const q_year = normalize_str(readlineSync.question("Year Released (exact): "));
      const q_tag = normalize_str(readlineSync.question("Tag/Genre (partial ok): "));

      console.log("Price filter options:");
      console.log("  1) Exact price");
      console.log("  2) Less than");
      console.log("  3) Greater than");
      console.log("  4) Range");
      console.log("  5) No price filter");

      const choice = readlineSync.question("Choose (1-5): ").trim();

      const filters = [];

      if (q_name) filters.push({ name: { $regex: q_name, $options: "i" } });
      if (q_author) filters.push({ authors: { $elemMatch: { $regex: q_author, $options: "i" } } });

      if (q_year) {
        const y = parseInt(q_year);
        if (!isNaN(y)) filters.push({ year: y });
      }

      if (q_tag) filters.push({ tags: { $elemMatch: { $regex: q_tag, $options: "i" } } });

      try {
        if (choice === "1") {
          const p = parseFloat(readlineSync.question("Price equals: "));
          if (!isNaN(p)) filters.push({ price: p });
        } else if (choice === "2") {
          const p = parseFloat(readlineSync.question("Price less than: "));
          if (!isNaN(p)) filters.push({ price: { $lt: p } });
        } else if (choice === "3") {
          const p = parseFloat(readlineSync.question("Price greater than: "));
          if (!isNaN(p)) filters.push({ price: { $gt: p } });
        } else if (choice === "4") {
          const p1 = parseFloat(readlineSync.question("Min price: "));
          const p2 = parseFloat(readlineSync.question("Max price: "));
          if (!isNaN(p1) && !isNaN(p2)) {
            filters.push({ price: { $gte: p1, $lte: p2 } });
          }
        }
      } catch {
        console.log("Invalid price input.");
      }

      const query = filters.length ? { $and: filters } : {};
      const results = await booksCol.find(query).sort({ name: 1 }).toArray();

      if (!results.length) {
        console.log("No books found.");
        return [];
      }

      results.forEach((b, idx) => print_book(b, idx + 1));
      return results;
    };

    const create_book = async () => {
      print_line();
      console.log("➕ Create Book");

      const name = normalize_str(readlineSync.question("Book name: "));
      const authors = readlineSync.question("Authors (comma-separated): ")
        .split(",")
        .map(a => normalize_str(a))
        .filter(Boolean);

      const year = parseInt(readlineSync.question("Year released: "));
      const tags = readlineSync.question("Tags/Genres (comma-separated): ")
        .split(",")
        .map(t => normalize_str(t))
        .filter(Boolean);

      const price = parseFloat(readlineSync.question("Price (₦): "));
      const synopsis = readlineSync.question("Synopsis: ");
      const copies = parseInt(readlineSync.question("Number of copies: "));

      if (!name || !authors.length || isNaN(year) || !tags.length || isNaN(price) || isNaN(copies) || copies < 0) {
        console.log("❌ Invalid input. Check name, authors, year, tags, price, and copies.");
        return;
      }

      for (const a of authors) await ensure_author(a);
      for (const t of tags) await ensure_tag(t);
      await ensure_year(year);

      const canon_key = canonical_book_key(name, authors, year, tags, price, synopsis);
      const search_key = normalize_str(name).toLowerCase();

      await booksCol.insertOne({
        name,
        authors,
        year,
        tags,
        price,
        synopsis,
        copies,
        canon_key,
        search_key,
        created_at: now(),
        updated_at: now()
      });

      console.log("✅ Book created successfully.");
    };

    const update_book = async () => {
      print_line();
      console.log("✏️ Update Book");

      const results = await search_books();
      if (!results.length) return;

      const idx = parseInt(readlineSync.question("Pick book number to update: ")) - 1;
      const book = results[idx];

      if (!book) {
        console.log("Invalid selection.");
        return;
      }

      const name = normalize_str(readlineSync.question(`New name [${book.name}]: `)) || book.name;

      const authorsInput = readlineSync.question(`New authors (comma) [${book.authors.join(", ")}]: `).trim();
      const authors = authorsInput
        ? authorsInput.split(",").map(a => normalize_str(a)).filter(Boolean)
        : book.authors;

      const yearInput = readlineSync.question(`New year [${book.year}]: `).trim();
      const year = yearInput ? parseInt(yearInput) : book.year;

      const tagsInput = readlineSync.question(`New tags (comma) [${book.tags.join(", ")}]: `).trim();
      const tags = tagsInput
        ? tagsInput.split(",").map(t => normalize_str(t)).filter(Boolean)
        : book.tags;

      const priceInput = readlineSync.question(`New price [${book.price}]: `).trim();
      const price = priceInput ? parseFloat(priceInput) : book.price;

      const synopsisInput = readlineSync.question(`New synopsis [${(book.synopsis || "").slice(0, 40)}...]: `);
      const synopsis = synopsisInput.trim() ? synopsisInput : book.synopsis;

      if (!name || !authors.length || isNaN(year) || !tags.length || isNaN(price)) {
        console.log("❌ Invalid updated values.");
        return;
      }

      for (const a of authors) await ensure_author(a);
      for (const t of tags) await ensure_tag(t);
      await ensure_year(year);

      const canon_key = canonical_book_key(name, authors, year, tags, price, synopsis);
      const search_key = normalize_str(name).toLowerCase();

      await booksCol.updateOne(
        { _id: book._id },
        {
          $set: {
            name,
            authors,
            year,
            tags,
            price,
            synopsis,
            canon_key,
            search_key,
            updated_at: now()
          }
        }
      );

      console.log("✅ Book updated.");
    };

    const delete_books = async () => {
      print_line();
      console.log("🗑️ Delete Books");

      const results = await search_books();
      if (!results.length) return;

      const idx = parseInt(readlineSync.question("Pick book number to delete: ")) - 1;
      const book = results[idx];

      if (!book) {
        console.log("Invalid selection.");
        return;
      }

      const activeRental = await usersCol.findOne({ "rentals.book_id": book._id });
      if (activeRental) {
        console.log("❌ Cannot delete this book because it is currently rented.");
        return;
      }

      if (!confirm(`Are you sure you want to delete "${book.name}"? (y/n): `)) {
        console.log("Cancelled.");
        return;
      }

      await booksCol.deleteOne({ _id: book._id });
      console.log("✅ Book deleted.");
    };

    const view_all_books = async () => {
      print_line();
      console.log("📚 All Books in the Library");

      const books = await booksCol.find().sort({ name: 1 }).toArray();

      if (!books.length) {
        console.log("❌ No books found in the library.");
        return;
      }

      books.forEach((book, idx) => {
        console.log(`\n[${idx + 1}] ${book.name}`);
        console.log(`   Authors: ${book.authors.join(", ")}`);
        console.log(`   Year: ${book.year}`);
        console.log(`   Tags: ${book.tags.join(", ")}`);
        console.log(`   Price: ₦${book.price}`);
        console.log(`   Copies Available: ${book.copies}`);
      });
    };

    const purchase_book = async () => {
      if (!require_login()) return;

      print_line();
      console.log("💳 Purchase Book");

      const raw = readlineSync.question("Enter book name: ");
      const query = normalize_str(raw);
      const regex = new RegExp(query.replace(/\s+/g, ".*"), "i");

      const matches = await booksCol.find({ name: { $regex: regex } }).toArray();
      if (!matches.length) {
        console.log("❌ No matching books found.");
        return;
      }

      matches.forEach((book, idx) => {
        console.log(`  [${idx + 1}] ${book.name} — ₦${book.price} — ${book.copies} copies`);
      });

      const sel = parseInt(readlineSync.question("Select book number to purchase: "));
      const book = matches[sel - 1];

      if (!book) {
        console.log("❌ Invalid selection.");
        return;
      }

      if (book.copies <= 0) {
        console.log("❌ Book is out of stock.");
        return;
      }

      const username = currentUser.username;

      await usersCol.updateOne(
        { username },
        {
          $push: { purchases: { book_id: book._id, date: now(), price: book.price } },
          $set: { updated_at: now() }
        }
      );

      await booksCol.updateOne(
        { _id: book._id },
        { $inc: { copies: -1 }, $set: { updated_at: now() } }
      );

      await record_transaction("purchase", username, [book], null);

      console.log(`✅ You purchased "${book.name}" for ₦${book.price}.`);
      currentUser = await usersCol.findOne({ username });
    };

    const rent_book = async () => {
      if (!require_login()) return;

      print_line();
      console.log("📖 Rent Book");

      const raw = readlineSync.question("Enter book name: ");
      const query = normalize_str(raw);
      const regex = new RegExp(query.replace(/\s+/g, ".*"), "i");

      const matches = await booksCol.find({ name: { $regex: regex } }).toArray();
      if (!matches.length) {
        console.log("❌ No matching books found.");
        return;
      }

      matches.forEach((book, idx) => {
        console.log(`  [${idx + 1}] ${book.name} — ₦${book.price} — ${book.copies} copies`);
      });

      const sel = parseInt(readlineSync.question("Select book number to rent: "));
      const book = matches[sel - 1];

      if (!book || book.copies <= 0) {
        console.log("❌ Invalid selection or book out of stock.");
        return;
      }

      const username = currentUser.username;
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 14);

      await usersCol.updateOne(
        { username },
        {
          $push: { rentals: { book_id: book._id, due_date: dueDate } },
          $set: { updated_at: now() }
        }
      );

      await booksCol.updateOne(
        { _id: book._id },
        { $inc: { copies: -1 }, $set: { updated_at: now() } }
      );

      await record_transaction("rental", username, [book], dueDate);

      console.log(`✅ You rented "${book.name}" — Due: ${dueDate.toISOString().slice(0, 10)}`);
      currentUser = await usersCol.findOne({ username });
    };

    const return_book = async () => {
      if (!require_login()) return;

      print_line();
      console.log("↩️ Return Book");

      const username = currentUser.username;
      const user = await ensure_user(username);

      if (!user?.rentals?.length) {
        console.log("❌ No rentals found for this user.");
        return;
      }

      const rentalMap = new Map(
        user.rentals.map(r => [r.book_id.toString(), r])
      );

      const ids = user.rentals.map(r => r.book_id);
      const books = await booksCol.find({ _id: { $in: ids } }).toArray();

      if (!books.length) {
        console.log("❌ No matching rented books found.");
        return;
      }

      books.forEach((b, idx) => {
        const rental = rentalMap.get(b._id.toString());
        const due = rental?.due_date;
        console.log(`  [${idx + 1}] ${b.name} — Due: ${new Date(due).toISOString().slice(0, 10)}`);
      });

      const sel = parseInt(readlineSync.question("Select book number to return: "));
      const book = books[sel - 1];

      if (!book) {
        console.log("❌ Invalid selection.");
        return;
      }

      await usersCol.updateOne(
        { username },
        {
          $pull: { rentals: { book_id: book._id } },
          $set: { updated_at: now() }
        }
      );

      await booksCol.updateOne(
        { _id: book._id },
        { $inc: { copies: 1 }, $set: { updated_at: now() } }
      );

      await record_transaction("return", username, [book], null);

      console.log(`✅ You returned "${book.name}".`);
      currentUser = await usersCol.findOne({ username });
    };

    const my_shelf = async () => {
      if (!require_login()) return;

      print_line();
      console.log("🧾 My Shelf");

      const username = currentUser.username;
      const user = await auto_return_overdues(username);

      const rentals = user.rentals || [];
      const purchases = user.purchases || [];

      console.log("📖 Rentals:");
      if (!rentals.length) {
        console.log("  None");
      } else {
        const rentalMap = new Map(
          rentals.map(r => [r.book_id.toString(), r])
        );

        const rentalIds = rentals.map(r => r.book_id);
        const books = await booksCol.find({ _id: { $in: rentalIds } }).toArray();

        books.forEach((b, idx) => {
          const rental = rentalMap.get(b._id.toString());
          const due = rental?.due_date;
          console.log(`  [${idx + 1}] ${b.name} — Due: ${new Date(due).toISOString().slice(0, 10)}`);
        });
      }

      console.log("\n💳 Purchases:");
      if (!purchases.length) {
        console.log("  None");
      } else {
        const purchaseMap = new Map(
          purchases.map(p => [p.book_id.toString(), p])
        );

        const purchaseIds = purchases.map(p => p.book_id);
        const books = await booksCol.find({ _id: { $in: purchaseIds } }).toArray();

        books.forEach((b, idx) => {
          const purchase = purchaseMap.get(b._id.toString());
          const date = purchase?.date;
          console.log(`  [${idx + 1}] ${b.name} — Purchased: ${new Date(date).toISOString().slice(0, 10)}`);
        });
      }

      console.log("\n📜 Transaction History:");
      const history = await transactionsCol.find({ username })
        .sort({ date: -1 })
        .limit(10)
        .toArray();

      if (!history.length) {
        console.log("  No recent transactions.");
      } else {
        history.forEach((trx, idx) => {
          const label =
            trx.type === "return" ? "Returned" :
            trx.type === "rental" ? "Rented" :
            "Purchased";

          const titles = (trx.items || []).map(i => i.book_name).join(", ");
          console.log(`  [${idx + 1}] ${label} — ${titles} — ${new Date(trx.date).toISOString().slice(0, 10)}`);
        });
      }

      currentUser = user;
    };

    const main_loop = async () => {
      while (true) {
        print_line();

        if (currentUser) {
          console.log(`👤 Logged in as: ${currentUser.username}`);
        } else {
          console.log("👤 Guest mode");
        }

        console.log("⚒️ Welcome to Booksmith ⚒️");
        console.log("📚 Book Shelf 📚");

        if (is_admin()) {
          console.log("  1) ➕ Create Books");
          console.log("  2) ✏️ Update Books");
          console.log("  3) 🗑️ Delete Books");
        } else {
          console.log("  1) ➕ Create Books (Admin only)");
          console.log("  2) ✏️ Update Books (Admin only)");
          console.log("  3) 🗑️ Delete Books (Admin only)");
        }

        console.log("  4) 🔎 Look Up Books");
        console.log("📙 My Shelf 📙");
        console.log("  5) 💳 Purchase Book");
        console.log("  6) 📖 Rent Book");
        console.log("  7) ↩️ Return Book");
        console.log("  8) 🧾 View My Shelf");
        console.log("  9) 📚 View All Books");

        if (currentUser) {
          console.log("  10) 🔑 Change Password");
          console.log("  11) 🚪 Logout");
          console.log("  12) Exit");
        } else {
          console.log("  10) 🚪 Login/Register");
          console.log("  11) Exit");
        }

        print_line();

        const sel = readlineSync.question("Enter a number: ").trim();

        if (!sel) {
          console.log("Please enter a number.");
          continue;
        }

        if (sel === "1") {
          if (require_admin()) await create_book();
        } else if (sel === "2") {
          if (require_admin()) await update_book();
        } else if (sel === "3") {
          if (require_admin()) await delete_books();
        } else if (sel === "4") {
          await search_books();
        } else if (sel === "5") {
          await purchase_book();
        } else if (sel === "6") {
          await rent_book();
        } else if (sel === "7") {
          await return_book();
        } else if (sel === "8") {
          await my_shelf();
        } else if (sel === "9") {
          await view_all_books();
        } else if (sel === "10") {
          if (currentUser) await change_password();
          else await start_session();
        } else if (sel === "11") {
          if (currentUser) {
            console.log("🚪 Logged out.");
            currentUser = null;
            await start_session();
          } else {
            console.log("Goodbye 👋");
            break;
          }
        } else if (sel === "12" && currentUser) {
          console.log("Goodbye 👋");
          break;
        } else {
          console.log("Invalid choice.");
        }

        readlineSync.question("\nPress Enter to continue...");
      }
    };

    await start_session();
    await main_loop();

  } catch (error) {
    console.error("❌ Error:", error.message);
  } finally {
    await client.close();
  }
})();
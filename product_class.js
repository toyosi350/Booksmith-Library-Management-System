const {MongoClient} = require('mongodb');
const readline = require('readline');
const mongoose = require('mongoose');


const uri = 'mongodb://127.0.0.1';

const client = new MongoClient(uri);

const db = 'LibraryManagementDB';
const collectionName = 'books';
console.log("script added")

client.connect()

const database = client.db(db);
const collection = database.collection(collectionName);

const bookSchema = new mongoose.Schema({
  title: { type: String, required: true },
  author: { type: String, required: true },
  category: { type: String, required: true },
  price: { type: Number, required: true },
  copies: { type: Number, default: 1 },  // Number of copies available
  createdAt: { type: Date, default: Date.now }
});


// Create Book Model
const Book = mongoose.model('Book', bookSchema);

// Setup readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Helper function to ask questions in the CLI
function askQuestion(query) {
  return new Promise(resolve => {
    rl.question(query, answer => {
      resolve(answer.trim());
    });
  });
}

// Function to add a book document to MongoDB
async function addBook(details) {
  try {
    const book = new Book({
      title: details.title,
      author: details.author,
      category: details.category,
      price: details.price,
      copies: details.copies || 1
    });
    const savedBook = await book.save();
    console.log('Book added successfully:');
    console.log(savedBook);
  } catch (error) {
    console.error('Error adding the book:', error.message);
  }
}

// Main function to prompt for book details and save them
async function getBookDetailsAndAdd() {
  try {
    console.log('Enter book details:');
    const title = await askQuestion('Title: ');
    const author = await askQuestion('Author: ');
    const category = await askQuestion('Category: ');
    const priceInput = await askQuestion('Price: ');
    const copiesInput = await askQuestion('Number of copies: ');

    const price = parseFloat(priceInput);
    const copies = parseInt(copiesInput, 10);

    // Basic validation
    if (!title ||!author ||!category) {
      console.log('Title, Author, and Category are required.');
      rl.close();
      return;
    }

    if (isNaN(price) || price <= 0) {
      console.log('Invalid price entered.');
      rl.close();
      return;
    }

    if (isNaN(copies) || copies < 0) {
      console.log('Invalid number of copies entered. Defaulting to 1.');
    }

    // Call function to save book details
    await addBook({
      title,
      author,
      category,
      price,
      copies: isNaN(copies) || copies < 0? 1 : copies
    });

  } catch (error) {
    console.error('An error occurred:', error.message);
  } finally {
    rl.close();
    // Disconnect from DB after operation to end the app cleanly
    mongoose.disconnect();
  }
}
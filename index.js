import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ChromaClient } from 'chromadb';
import dotenv from 'dotenv';

import { PDFParse } from 'pdf-parse';

dotenv.config();

const app = express();
app.use(express.json());
const upload = multer({ dest: "uploads/" });

// Gemini setup
const genAi = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ChromaDB setup with NoOp embedding function
const chromaClient = new ChromaClient({
    path: process.env.CHROMA_DB_URL,
});



const collection = await chromaClient.getOrCreateCollection({
    name: "rag_collection",
});



// Embedding using Gemini
async function getEmbedding(text) {
  const model = genAi.getGenerativeModel({ model: "gemini-embedding-001" });
  const res = await model.embedContent({
    content: { parts: [{ text }] }
  });
  return res.embedding.values;
}




//  Chunking utility
function chunkText(text, chunkSize = 500, overlap = 100) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize - overlap) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

// Upload route 
app.post('/upload', upload.single('file'), async (req, res) => {
  let parser;
  try {
    const filePath = req.file.path;
    const buffer = fs.readFileSync(filePath);
    
    
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy(); // Always clean up
    
    const chunks = chunkText(result.text);

    for (let i = 0; i < chunks.length; i++) {
      const embedding = await getEmbedding(chunks[i]);
      
      await collection.add({
        ids: [`doc-${Date.now()}-${i}`],
        documents: [chunks[i]],      // Array of strings
        embeddings: [embedding],     // Plural key + array of arrays
      });
    }

    fs.unlinkSync(filePath);
    res.json({ message: "PDF uploaded & indexed with Gemini" });

  } catch (err) {
    console.error(err);
    // Ensure parser is destroyed even on error
    if (parser) await parser.destroy().catch(() => {});
    res.status(500).json({ error: "upload failed" });
  }
});

// Query route
app.post("/query", async (req, res) => {
  try {
    const { question } = req.body;
    const queryEmbedding = await getEmbedding(question);

    const result = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: 3,
    });

    const context = result.documents[0]?.join("\n") || "";

    const model = genAi.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `Answer ONLY from the provided context.\nContext: ${context}\nQuestion: ${question}`;

    const response = await model.generateContent(prompt);
    
    res.json({
      answer: response.response.text(),
      context,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Query Failed' });
  }
});

app.listen(3000, () => {
  console.log("✨ Gemini RAG running on http://localhost:3000");
});
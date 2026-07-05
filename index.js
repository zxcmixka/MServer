const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const onlineUsers = new Map();

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not defined");
}

app.use(express.json());
app.use(cors({ origin: "https://budka-virid.vercel.app" }));

const io = new Server(server, {
  cors: { origin: "https://budka-virid.vercel.app", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"],
  allowEIO3: true,
});

const MONGO_URI = process.env.MONGO_URI;

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

const User = mongoose.model(
  "User",
  new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
  }),
);

const Request = mongoose.model(
  "Request",
  new mongoose.Schema({
    sender: { type: String, required: true },
    receiver: { type: String, required: true },
    status: { type: String, enum: ["pending", "accepted"], default: "pending" },
  }),
);

const Chat = mongoose.model(
  "Chat",
  new mongoose.Schema({
    participants: [{ type: String, required: true }],
  }),
);

const Message = mongoose.model(
  "Message",
  new mongoose.Schema({
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
    },
    user: String,
    text: String,
    timestamp: { type: Date, default: Date.now },
  }),
);

const MessageSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: "Chat", required: true },
  user: String,
  text: String,
  type: { type: String, enum: ["text", "image"], default: "text" },
  timestamp: { type: Date, default: Date.now },
});

const multer = require("multer");
const path = require("path");

// Настройка папки для хранения картинок
const storage = multer.diskStorage({
  destination: "./uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); // Имя файла = таймстамп + расширение
  },
});
const upload = multer({ storage });

// Разрешаем доступ к папке uploads из интернета
app.use("/uploads", express.json(), express.static("uploads"));

// Эндпоинт для загрузки картинок
app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Файл не загружен" });

  // Возвращаем клиенту полный публичный URL картинки
  const imageUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
  res.json({ imageUrl });
});

app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    const candidate = await User.findOne({ username });
    if (candidate) return res.status(400).json({ message: "Имя занято" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();
    res.status(201).json({ message: "Успешно!" });
  } catch (e) {
    res.status(500).json({ message: "Ошибка при регистрации" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ message: "Неверные данные" });
    }
    const token = jwt.sign(
      { userId: user._id, username: user.username },
      JWT_SECRET,
      { expiresIn: "30d" },
    );
    res.json({ token, username: user.username });
  } catch (e) {
    res.status(500).json({ message: "Ошибка при входе" });
  }
});

app.post("/api/requests/send", async (req, res) => {
  try {
    const { sender, receiver } = req.body;
    if (sender === receiver)
      return res
        .status(400)
        .json({ message: "Нельзя отправить запрос самому себе" });

    const targetUser = await User.findOne({ username: receiver });
    if (!targetUser)
      return res.status(404).json({ message: "Пользователь не найден" });

    const existing = await Request.findOne({ sender, receiver });
    if (existing)
      return res.status(400).json({ message: "Запрос уже отправлен" });

    const newRequest = new Request({ sender, receiver });
    await newRequest.save();

    io.to(receiver).emit("new invitation");
    res.json({ message: "Запрос отправлен!" });
  } catch (e) {
    res.status(500).json({ message: "Ошибка сервера" });
  }
});

app.get("/api/users/:username/data", async (req, res) => {
  const { username } = req.params;
  try {
    const incomingRequests = await Request.find({
      receiver: username,
      status: "pending",
    });

    const activeChats = await Chat.find({ participants: username });

    const chatsWithLastMessage = await Promise.all(
      activeChats.map(async (chat) => {
        const lastMsg = await Message.findOne({ chatId: chat._id })
          .sort({ timestamp: -1 })
          .limit(1);

        return {
          _id: chat._id,
          participants: chat.participants,
          lastMessage: lastMsg
            ? {
                user: lastMsg.user,
                text: lastMsg.text,
                timestamp: lastMsg.timestamp,
              }
            : null,
        };
      }),
    );

    res.json({ incomingRequests, activeChats: chatsWithLastMessage });
  } catch (e) {
    res.status(500).json({ message: "Ошибка получения данных" });
  }
});

app.post("/api/requests/accept", async (req, res) => {
  try {
    const { requestId } = req.body;
    const request = await Request.findById(requestId);
    if (!request) return res.status(404).json({ message: "Запрос не найден" });

    request.status = "accepted";
    await request.save();

    const newChat = new Chat({
      participants: [request.sender, request.receiver],
    });
    await newChat.save();

    await Request.findByIdAndDelete(requestId);

    io.to(request.sender).emit("invitation updated");
    io.to(request.receiver).emit("invitation updated");

    res.json({ message: "Запрос принят, чат создан!" });
  } catch (e) {
    res.status(500).json({ message: "Ошибка при принятии запроса" });
  }
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("Token missing"));
  try {
    socket.userData = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  const currentUsername = socket.userData.username;

  onlineUsers.set(currentUsername, socket.id);
  socket.join(currentUsername);
  console.log(`🔌 В сети: ${currentUsername}`);

  io.emit("user status changed", {
    username: currentUsername,
    status: "online",
  });

  socket.on("join chat", async (chatId) => {
    socket.rooms.forEach((room) => {
      if (room !== socket.id && room !== currentUsername) socket.leave(room);
    });

    socket.join(chatId);

    try {
      const history = await Message.find({ chatId })
        .sort({ timestamp: -1 })
        .limit(50);
      socket.emit("chat history", history.reverse());
    } catch (err) {
      console.error("Ошибка загрузки истории:", err);
    }
  });

  socket.on("check user status", (targetUsername) => {
    const isOnline = onlineUsers.has(targetUsername);
    socket.emit("user status response", {
      username: targetUsername,
      status: isOnline ? "online" : "offline",
    });
  });

  socket.on("send message", async (data) => {
    try {
      const newMessage = new Message({
        chatId: data.chatId,
        user: currentUsername,
        text: data.text,
        type: data.type || "text",
      });
      await newMessage.save();

      const currentChat = await Chat.findById(data.chatId);
      if (currentChat) {
        currentChat.participants.forEach((username) => {
          io.to(username).emit("new message", newMessage);
          io.to(username).emit("invitation updated");
        });
      }
    } catch (err) {
      console.error("❌ Ошибка при отправке сообщения:", err);
    }
  });

  socket.on("typing", async (data) => {
    try {
      const currentChat = await Chat.findById(data.chatId);
      if (currentChat) {
        const companion = currentChat.participants.find(
          (p) => p !== currentUsername,
        );
        if (companion) {
          io.to(companion).emit("user typing", {
            chatId: data.chatId,
            username: currentUsername,
            isTyping: data.isTyping,
          });
        }
      }
    } catch (err) {
      console.error(err);
    }
  });

  socket.on("disconnect", () => {
    console.log(`❌ Отключился: ${currentUsername}`);
    onlineUsers.delete(currentUsername);
    socket.leave(currentUsername);

    io.emit("user status changed", {
      username: currentUsername,
      status: "offline",
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));

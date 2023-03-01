import dealWebsocket from "./socket.mjs";
import Io from "socket.io";

const io = Io("9000");

io.on("connection", (socket) => dealWebsocket({ io, socket }));

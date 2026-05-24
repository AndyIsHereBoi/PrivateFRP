import { describe, it, expect } from "bun:test";
import { encodeFrame, decodeFrame, parseAgentHello, parseServerHello, parseHeartbeat } from "../src/protocol/frame.js";
import { FrameType } from "../src/constants.js";

describe("Protocol - Frame Encoding/Decoding", () => {
  describe("encodeFrame and decodeFrame", () => {
    it("should encode and decode a frame with empty body", () => {
      const type = FrameType.AgentHello;
      const id = 1;
      const body = new Uint8Array();

      const encoded = encodeFrame(type, id, body);
      expect(encoded.length).toBe(9); // HEADER_SIZE

      const decoded = decodeFrame(encoded);
      expect(decoded.type).toBe(type);
      expect(decoded.id).toBe(id);
      expect(decoded.body.length).toBe(0);
    });

    it("should encode and decode a frame with data", () => {
      const type = FrameType.Heartbeat;
      const id = 2;
      const body = new Uint8Array([1, 2, 3, 4, 5]);

      const encoded = encodeFrame(type, id, body);
      expect(encoded.length).toBe(9 + 5); // HEADER_SIZE + body length

      const decoded = decodeFrame(encoded);
      expect(decoded.type).toBe(type);
      expect(decoded.id).toBe(id);
      expect(decoded.body.length).toBe(5);
      expect(decoded.body[0]).toBe(1);
    });

    it("should throw error for frame too small", () => {
      const smallData = new Uint8Array([1, 2, 3]);
      expect(() => decodeFrame(smallData)).toThrow();
    });
  });

  describe("parseAgentHello", () => {
    it("should parse valid AgentHello payload", () => {
      const payload = JSON.stringify({
        version: "1.0",
        agentId: "test-agent",
        secret: "test-secret",
      });
      const body = new TextEncoder().encode(payload);

      const result = parseAgentHello(body);
      expect(result.version).toBe("1.0");
      expect(result.agentId).toBe("test-agent");
      expect(result.secret).toBe("test-secret");
    });

    it("should throw error for invalid JSON", () => {
      const body = new Uint8Array([0x7b, 0x22, 0x69]); // Invalid JSON
      expect(() => parseAgentHello(body)).toThrow();
    });
  });

  describe("parseServerHello", () => {
    it("should parse valid ServerHello payload", () => {
      const payload = JSON.stringify({
        version: "1.0",
        serverId: "test-server",
        success: true,
        message: "Welcome",
      });
      const body = new TextEncoder().encode(payload);

      const result = parseServerHello(body);
      expect(result.version).toBe("1.0");
      expect(result.serverId).toBe("test-server");
      expect(result.success).toBe(true);
      expect(result.message).toBe("Welcome");
    });
  });

  describe("parseHeartbeat", () => {
    it("should parse valid Heartbeat payload", () => {
      const payload = JSON.stringify({
        timestamp: Date.now(),
        latency: 50,
      });
      const body = new TextEncoder().encode(payload);

      const result = parseHeartbeat(body);
      expect(typeof result.timestamp).toBe("number");
      expect(result.latency).toBe(50);
    });
  });
});

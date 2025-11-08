const express = require("express");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const { URL } = require("url");
const app = express();
const PORT = parseInt(process.env.PORT, 10) || 4000;
const API_KEY = process.env.API_KEY || "";
const NODE_ENV = process.env.NODE_ENV || "development";

app.use(cors());
app.use(express.json({ limit: "500kb" }));
app.use(express.urlencoded({ extended: true, limit: "500kb" }));

const PLATFORM_DOMAINS = Object.freeze({
  YouTube: ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"],
  TikTok: ["tiktok.com", "www.tiktok.com", "vm.tiktok.com"],
  Facebook: ["facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch"],
});

const TIKTOK_API_URL = "https://www.tikwm.com/api/";
const NOEMBED_API_URL = "https://noembed.com/embed";

/**
 * Checks if a string is a valid HTTP/HTTPS URL.
 * @param {string} string The URL string to validate.
 * @returns {boolean}
 */
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}

/**
 * Determines if the URL belongs to an allowed platform and returns the platform name.
 * @param {string} url The URL string to check.
 * @returns {string | null} The platform name (YouTube, TikTok, Facebook) or null.
 */
function extractPlatform(url) {
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();

    for (const [platform, domains] of Object.entries(PLATFORM_DOMAINS)) {
      if (domains.some((domain) => hostname.includes(domain))) {
        return platform;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Cleans YouTube URLs by extracting the video ID and ensuring a standard format.
 * @param {string} url The raw YouTube URL.
 * @returns {string} The cleaned standard URL or the original if cleaning fails.
 */
function cleanYouTubeUrl(url) {
  try {
    const urlObj = new URL(url);
    let videoId = null;

    if (
      urlObj.hostname.includes("youtu.be") ||
      urlObj.pathname.includes("/shorts/")
    ) {
      const pathSegments = urlObj.pathname.split("/");
      videoId = pathSegments.find(
        (segment) => segment.length >= 10 && segment.length <= 11
      );
    }

    if (!videoId && urlObj.hostname.includes("youtube.com")) {
      videoId = urlObj.searchParams.get("v");
    }

    if (videoId) {
      const cleanUrl = new URL("https://www.youtube.com/watch");
      cleanUrl.searchParams.set("v", videoId);
      return cleanUrl.toString();
    }

    return url;
  } catch (error) {
    console.error("URL cleaning error:", error);
    return url;
  }
}

/**
 * Extracts YouTube video ID from a cleaned URL.
 * @param {string} url The cleaned YouTube URL.
 * @returns {string | null}
 */
function extractYouTubeId(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.get("v");
  } catch {
    return null;
  }
}

/**
 * Helper function to format duration in seconds into MM:SS or HH:MM:SS.
 * @param {number} seconds The duration in seconds.
 * @returns {string} Formatted duration string.
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || seconds < 0) return "Unknown";

  try {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [m, s];
    if (h > 0) {
      parts.unshift(h);
    }

    return parts
      .map((part, index) => {
        return index === 0 && h > 0
          ? part.toString()
          : part.toString().padStart(2, "0");
      })
      .join(":");
  } catch {
    return "Unknown";
  }
}

/**
 * Fetches YouTube metadata using noembed.com and provides hardcoded download options.
 * @param {string} url The cleaned YouTube URL.
 * @returns {object} Video metadata.
 */
async function getYouTubeMetadata(url) {
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    throw new Error("YouTube: Invalid video URL or ID could not be extracted.");
  }

  try {
    const response = await axios.get(
      `${NOEMBED_API_URL}?url=${encodeURIComponent(url)}`,
      { timeout: 8000 }
    );

    const data = response.data;
    if (data.error) {
      throw new Error(data.error);
    }

    const qualityOptions = [
      {
        id: "best",
        label: "Best Quality (External)",
        ext: "mp4",
        quality: "1080p",
      },
      { id: "720p", label: "HD 720p (External)", ext: "mp4", quality: "720p" },
      { id: "480p", label: "SD 480p (External)", ext: "mp4", quality: "480p" },
      {
        id: "audio",
        label: "Audio Only (External)",
        ext: "mp3",
        quality: "audio",
      },
    ];

    return {
      id: videoId,
      title: data.title || "YouTube Video",
      uploader: data.author_name || "YouTube",
      duration: "Unknown", // Noembed doesn't provide duration
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      description: data.title || "",
      viewCount: null,
      uploadDate: null,
      options: qualityOptions,
      platform: "YouTube",
    };
  } catch (error) {
    const errorMessage = error.response?.data?.error || error.message;
    console.error("YouTube metadata error:", errorMessage);
    throw new Error(
      `YouTube: Could not fetch video information. Reason: ${errorMessage}`
    );
  }
}

/**
 * Fetches TikTok metadata and reliable download links from tikwm.com.
 * @param {string} url The TikTok video URL.
 * @returns {object} Video metadata.
 */
async function getTikTokMetadata(url) {
  try {
    const response = await axios.post(
      TIKTOK_API_URL,
      { url: url },
      {
        timeout: 10000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Content-Type": "application/json",
        },
      }
    );

    const responseData = response.data;

    if (responseData.code !== 0 || !responseData.data) {
      const errorMsg = responseData.msg || "Video not found or unavailable.";
      throw new Error(`TikTok API Error: ${errorMsg}`);
    }

    const data = responseData.data;
    const qualityOptions = [];

    if (data.play) {
      qualityOptions.push({
        id: "nowm",
        format_id: "nowm",
        label: "HD (No Watermark)",
        ext: "mp4",
        quality: "best",
        url: data.play,
      });
    }

    if (data.wmplay) {
      qualityOptions.push({
        id: "wm",
        format_id: "wm",
        label: "Standard (With Watermark)",
        ext: "mp4",
        quality: "standard",
        url: data.wmplay,
      });
    }

    if (qualityOptions.length === 0) {
      throw new Error("No video formats available for this TikTok.");
    }
    return {
      id: data.id || `tiktok-${Date.now()}`,
      title: data.title || "TikTok Video",
      uploader:
        data.author?.nickname || data.author?.unique_id || "TikTok User",
      duration: formatDuration(data.duration),
      thumbnail: data.cover || data.images?.[0] || null,
      description: data.title || "",
      viewCount: data.play_count,
      options: qualityOptions,
      platform: "TikTok",
    };
  } catch (error) {
    console.error("TikTok metadata error:", error.message);
    throw new Error(`TikTok: ${error.message}`);
  }
}

/**
 * Fetches Facebook metadata using noembed.com and provides hardcoded download options.
 * @param {string} url The Facebook video URL.
 * @returns {object} Video metadata.
 */
async function getFacebookMetadata(url) {
  try {
    const response = await axios.get(
      `${NOEMBED_API_URL}?url=${encodeURIComponent(url)}`,
      { timeout: 8000 }
    );

    const data = response.data;
    if (data.error) {
      throw new Error(data.error);
    }

    const qualityOptions = [
      {
        id: "best",
        label: "Best Quality (External)",
        ext: "mp4",
        quality: "best",
      },
      {
        id: "sd",
        label: "Standard Quality (External)",
        ext: "mp4",
        quality: "480p",
      },
      {
        id: "audio",
        label: "Audio Only (External)",
        ext: "mp3",
        quality: "audio",
      },
    ];

    const videoId = url.split("/").pop() || `fb-${Date.now()}`;

    return {
      id: videoId,
      title: data.title || "Facebook Video",
      uploader: data.author_name || "Facebook",
      duration: "Unknown",
      thumbnail: data.thumbnail_url || null,
      description: data.title || "",
      viewCount: null,
      options: qualityOptions,
      platform: "Facebook",
    };
  } catch (error) {
    const errorMessage = error.response?.data?.error || error.message;
    console.error("Facebook metadata error:", errorMessage);
    throw new Error(
      `Facebook: Could not fetch video information. Reason: ${errorMessage}`
    );
  }
}

/**
 * @route GET /api/health
 * @description Health check endpoint.
 */
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Service is healthy",
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    platforms: {
      YouTube: "Download: External Redirect; Metadata: Noembed",
      TikTok: "Download: Direct Proxy; Metadata: tikwm.com",
      Facebook: "Download: External Redirect; Metadata: Noembed",
    },
  });
});

/**
 * @route GET /api/metadata
 * @description Retrieves metadata and download options for a video URL.
 */
app.get("/api/metadata", async (req, res) => {
  const rawUrl = req.query.url?.trim();

  if (!rawUrl) {
    return res.status(400).json({
      success: false,
      error: "URL parameter is required.",
    });
  }

  if (!isValidUrl(rawUrl)) {
    return res.status(400).json({
      success: false,
      error: "Invalid URL format. Must include http:// or https://",
    });
  }

  const platform = extractPlatform(rawUrl);

  if (!platform) {
    const supported = Object.keys(PLATFORM_DOMAINS).join(", ");
    return res.status(400).json({
      success: false,
      error: `Unsupported platform. Supported: ${supported}`,
    });
  }

  let url = rawUrl;

  try {
    let metadata;

    if (platform === "YouTube") {
      url = cleanYouTubeUrl(rawUrl);
      metadata = await getYouTubeMetadata(url);
    } else if (platform === "TikTok") {
      metadata = await getTikTokMetadata(url);
    } else if (platform === "Facebook") {
      metadata = await getFacebookMetadata(url);
    } else {
      throw new Error("Platform mismatch");
    }

    res.json({
      success: true,
      data: metadata,
    });
  } catch (error) {
    console.error("Metadata error for URL:", url, "Error:", error.message);

    let statusCode = 500;
    let errorMessage = error.message;

    if (
      errorMessage.includes("not found") ||
      errorMessage.includes("unavailable")
    ) {
      statusCode = 404;
    } else if (
      errorMessage.includes("Invalid") ||
      errorMessage.includes("Unsupported")
    ) {
      statusCode = 400;
    } else if (errorMessage.includes("timeout")) {
      statusCode = 504;
    }

    res.status(statusCode).json({
      success: false,
      error: errorMessage,
    });
  }
});

/**
 * @route GET /api/download
 * @description Initiates video download (direct proxy for TikTok, redirect for others).
 */
app.get("/api/download", async (req, res) => {
  try {
    const url = req.query.url?.trim();
    const { format, key } = req.query;

    if (API_KEY && key !== API_KEY) {
      return res.status(401).json({
        success: false,
        error: "Invalid API key.",
      });
    }

    if (!url || !isValidUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "Invalid or missing URL parameter.",
      });
    }

    const platform = extractPlatform(url);

    if (!platform) {
      return res.status(400).json({
        success: false,
        error: "Unsupported platform for download.",
      });
    }

    console.log(
      `Download request: Platform=${platform}, URL=${url}, Format=${format}`
    );

    if (platform === "YouTube") {
      const cleanUrl = cleanYouTubeUrl(url);
      const downloadUrl = `https://loader.to/api/download/?url=${encodeURIComponent(
        cleanUrl
      )}&format=mp4`;

      return res.redirect(302, downloadUrl);
    } else if (platform === "Facebook") {
      const downloadUrl = `https://getmyfb.com/process/?url=${encodeURIComponent(
        url
      )}`;

      return res.redirect(302, downloadUrl);
    } else if (platform === "TikTok") {
      const metadata = await getTikTokMetadata(url);

      const selectedOption =
        metadata.options.find((opt) => opt.id === format) ||
        metadata.options.find((opt) => opt.id === "nowm") ||
        metadata.options[0];

      if (!selectedOption || !selectedOption.url) {
        throw new Error("No valid download URL found for the selected format.");
      }

      const videoResponse = await axios({
        method: "GET",
        url: selectedOption.url,
        responseType: "stream",
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: "https://www.tiktok.com/",
        },
      });

      const ext = selectedOption.ext || "mp4";
      const filename = `${metadata.title
        .replace(/[^a-z0-9]/gi, "_")
        .toLowerCase()}.${ext}`;

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
      res.setHeader(
        "Content-Type",
        selectedOption.hasAudio === false ? "audio/mpeg" : "video/mp4"
      );

      return videoResponse.data.pipe(res);
    }
  } catch (error) {
    console.error("Download endpoint error:", error);
    if (!res.headersSent) {
      let statusCode = 500;
      if (error.message.includes("No valid download URL")) statusCode = 404;

      res.status(statusCode).json({
        success: false,
        error: "Download failed: " + error.message,
      });
    }
  }
});

app.use(express.static(path.join(__dirname, "../frontend/dist")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/dist/index.html"));
});

app.use((err, req, res, next) => {
  console.error("Global Error Handler:", err.stack);
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: `Internal Server Error: ${err.message}`,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} in ${NODE_ENV} mode`);
  console.log(
    `📱 Supported platforms: ${Object.keys(PLATFORM_DOMAINS).join(", ")}`
  );
  console.log(
    `🔑 API Key Required: ${API_KEY ? 'Yes (pass in "key" query param)' : "No"}`
  );
  console.log(
    `🔧 Health check available at http://localhost:${PORT}/api/health`
  );
});

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const { ObjectId, GridFSBucket } = require("mongodb");
const path = require("path");
const fs = require("fs");
const db = require("../config/connection");
const crypto = require("crypto");

const NOVEL_COVERS_BUCKET = "novelCovers";

function uploadNovelCover(image) {
  const extension = path.extname(image.name || "").toLowerCase();
  const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

  if (!allowedTypes.has(image.mimetype) || !allowedExtensions.has(extension)) {
    throw new Error("Cover image must be a JPG, PNG, or WEBP file.");
  }
  if (image.size > 5 * 1024 * 1024) {
    throw new Error("Cover image must be 5MB or smaller.");
  }

  const bucket = new GridFSBucket(db.get(), { bucketName: NOVEL_COVERS_BUCKET });
  const upload = bucket.openUploadStream(`${crypto.randomUUID()}${extension}`, {
    contentType: image.mimetype,
    metadata: { originalName: image.name, uploadedAt: new Date() }
  });

  return new Promise((resolve, reject) => {
    upload.on("error", reject);
    upload.on("finish", () => resolve(upload.id));
    upload.end(image.data);
  });
}

function startOfUTCDay(d){
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Covers uploaded after this change live in MongoDB GridFS instead of the
// server's temporary filesystem. Older covers remain available from /public.
router.get("../public/images/novel-images/:coverId", async (req, res, next) => {
  if (!ObjectId.isValid(req.params.coverId)) return next();

  try {
    const bucket = new GridFSBucket(db.get(), { bucketName: NOVEL_COVERS_BUCKET });
    const file = await db.get().collection(`${NOVEL_COVERS_BUCKET}.files`).findOne({
      _id: new ObjectId(req.params.coverId)
    });

    if (!file) return next();

    res.type(file.contentType || "application/octet-stream");
    bucket.openDownloadStream(file._id)
      .on("error", next)
      .pipe(res);
  } catch (error) {
    next(error);
  }
});

// Search API
router.get("/api/search", async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    if (!query || query.length < 2) return res.json([]);

    const novelsCol = db.get().collection("novels");
    const results = await novelsCol
      .find({
        $or: [
          { title: { $regex: query, $options: 'i' } },
          { author: { $regex: query, $options: 'i' } }
        ]
      })
      .limit(8)
      .project({ _id: 1, title: 1, author: 1, imageUrl: 1, categ: 1 })
      .toArray();

    res.json(results.map(n => ({
      _id: n._id.toString(),
      title: n.title,
      author: n.author,
      imageUrl: n.imageUrl || '',
      categ: n.categ || ''
    })));
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json([]);
  }
});

//logout
router.get("/staff/logout", (req, res) => {
  const sid = req.sessionID;
  if (!req.session) return res.redirect("/staff/login");
  req.session.destroy(err => {
    res.clearCookie(process.env.SESSION_COOKIE_NAME || "connect.sid", { path: "/" });
    if (err) {
      console.error("Session destroy error for SID", sid, err);
      return res.redirect("/staff");
    }
    console.log("Session destroyed for SID", sid);
    return res.redirect("/staff/login");
  });
});

// Staff Login Page
router.get("/staff/login", (req, res) => {
  res.render("staff/staff-login", { Loginerr: req.session.Loginerr || null });
  req.session.Loginerr = null;
});

router.post("/staff/login", async (req, res) => {
  try {
    const staff = await db.get().collection("staff").findOne({ Username: req.body.Username });
    if (!staff) {
      req.session.Loginerr = "Invalid username or password";
      return res.redirect("/staff/login");
    }
    const ok = await bcrypt.compare(req.body.Password, staff.Password);
    if (!ok) {
      req.session.Loginerr = "Invalid username or password";
      return res.redirect("/staff/login");
    }
    req.session.Staff = staff.Username;
    // store as string to avoid ObjectId serialization issues
    req.session.staffId = staff._id.toString();

    console.log("Session after login:", req.session);
    console.log("Session ID:", req.sessionID);

    res.redirect("/staff");
  } catch (err) {
    console.error("Login error:", err);
    req.session.Loginerr = "Login failed. Try again.";
    res.redirect("/staff/login");
  }
});

router.get("/staff/forgot", (req, res) => {
  res.render("staff/forgot-staff", { error: null });
});

// Receive staff email, send password reset email
router.post("/password-reset-staff", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send("Email is required.");
  try {
    const staff = await db.get().collection("staff").findOne({ Email: email });
    if (!staff) return res.status(400).send("Staff not found.");

    const token = crypto.randomBytes(32).toString("hex");
    const tokenExpiration = new Date();
    tokenExpiration.setMinutes(tokenExpiration.getMinutes() + 10);

    await db.get().collection("staff").updateOne(
      { _id: staff._id },
      { $set: { resetToken: token, tokenExpiration } }
    );

    // Use your existing email helper; third arg true indicates staff
    const mailer = require("../helpers/emailHelper");
    await mailer.sendResetEmail(email, token, true);

    res.status(200).send("Password reset email sent successfully.");
  } catch (err) {
    console.error("Error during sending reset email:", err);
    res.status(500).send("An error occurred while sending the email: " + err.message);
  }
});

// Reset form from email link
router.get("/staff/reset-password", (req, res) => {
  const { token } = req.query;
  res.render("staff/Email-reset-staff", { token });
});

// Update staff password
router.post("/update-password-staff", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).send("Token and new password are required.");
  try {
    const staff = await db.get().collection("staff").findOne({ resetToken: token });
    if (!staff || new Date() > staff.tokenExpiration) {
      return res.status(400).send("Token is invalid or expired.");
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.get().collection("staff").updateOne(
      { _id: staff._id },
      { $set: { Password: hashedPassword }, $unset: { resetToken: "", tokenExpiration: "" } }
    );
    res.status(200).send("Password reset successful.");
  } catch (err) {
    console.error("Error during password update:", err.message);
    res.status(500).send("An error occurred while updating the password.");
  }
});

// Staff Home
router.get("/staff", async (req, res) => {
  if (!req.session.staffId) {
    return res.redirect("/staff/login");
  }
  try {
    let staff = await db.get().collection("staff").findOne({ _id: new ObjectId(req.session.staffId) });
    const novelsCol = db.get().collection("novels");
    const chaptersCol = db.get().collection("chapters");

    // Staff novels
    const staffNovels = await novelsCol
    .find({})
    .sort({ createdAt: -1 })
    .limit(10)
    .project({ _id: 1, title: 1, status: 1, imageUrl: 1 })
    .toArray();

    if (staffNovels.length) {
      const staffIds = staffNovels.map(n => n._id);
      const staffCounts = await chaptersCol
        .aggregate([
          { $match: { novelId: { $in: staffIds } } },
          { $group: { _id: "$novelId", count: { $sum: 1 } } }
        ])
        .toArray();
      const staffCountMap = new Map(staffCounts.map(c => [String(c._id), c.count]));
      staffNovels.forEach(n => n.chapters = staffCountMap.get(String(n._id)) || 0);
    }
    // 6 random novels for hero
    let randomNovels = await novelsCol
      .aggregate([
        { $sample: { size: 6 } },
        {
          $project: {
            _id: 1,
            title: 1,
            description: 1,
            status: 1,
            categ: 1,
            audience: 1,
            imageUrl: 1
          }
        }
      ])
      .toArray();

    // chapter counts in bulk
    if (randomNovels.length) {
      const ids = randomNovels.map(n => n._id);
      const counts = await chaptersCol
        .aggregate([
          { $match: { novelId: { $in: ids } } },
          { $group: { _id: "$novelId", count: { $sum: 1 } } }
        ])
        .toArray();
      const countMap = new Map(counts.map(c => [String(c._id), c.count]));
      randomNovels = randomNovels.map(n => ({ ...n, chapters: countMap.get(String(n._id)) || 0 }));
    }

    // Handle expired membership
    if (staff && staff.plan && staff.plan.expires && new Date(staff.plan.expires) < new Date()) {
      await db.get().collection("staff").updateOne(
        { _id: staff._id },
        { $set: { "plan.name": "Free", "plan.expires": null, "profileFrame": null } }
      );
      staff.plan.name = "Free";
      staff.plan.expires = null;
      staff.profileFrame = null;
    }

    res.render("staff/home-staff", {
      staff,
      profileImageUrl: staff?.profileImage || null,
      profileFrame: staff?.profileFrame || null,
      coinCount: typeof staff?.coins === "number" ? staff.coins : 0,
      membership: staff?.membership || null,
      staffNovels,
      randomNovels,                          
      randomNovelsJson: JSON.stringify(randomNovels) // <-- use this in template
    });
  } catch (err) {
    console.error("Staff home error:", err);
    res.redirect("/staff/login");
  }
});

router.post('/staff/bookmark', async (req, res) => {
  if (!req.session.staffId) return res.redirect("/staff/login");
  const staffId = new ObjectId(req.session.staffId);
  const { novelId } = req.body;
  if (!novelId) return res.redirect("/staff/bookmarks");

  // Prevent duplicate bookmarks
  const exists = await db.get().collection('bookmarkS').findOne({ staffId, novelId: new ObjectId(novelId) });
  if (!exists) {
    await db.get().collection('bookmarkS').insertOne({
      staffId,
      novelId: new ObjectId(novelId),
      createdAt: new Date()
    });
  }
  // res.redirect('/staff/bookmarks');
});

router.get("/staff/bookmarks", async (req, res) => {
  if (!req.session.staffId) return res.redirect("/staff/login");
  const staffId = new ObjectId(req.session.staffId);

  const staff = await db.get().collection("staff").findOne({ _id: staffId });

  // Get all bookmarked novel IDs for this user
  const bookmarks = await db.get().collection('bookmarkS').find({ staffId }).toArray();
  const novelIds = bookmarks.map(b => b.novelId);

  // Fetch novel details
  let novels = novelIds.length
    ? await db.get().collection('novels').find({ _id: { $in: novelIds } }).toArray()
    : [];

  // Attach chapter counts
  if (novels.length) {
    const chaptersCol = db.get().collection("chapters");
    const ids = novels.map(n => n._id);
    const counts = await chaptersCol.aggregate([
      { $match: { novelId: { $in: ids } } },
      { $group: { _id: "$novelId", count: { $sum: 1 } } }
    ]).toArray();
    const countMap = new Map(counts.map(c => [String(c._id), c.count]));
    novels = novels.map(n => ({ ...n, chapters: countMap.get(String(n._id)) || 0 }));
  }

  res.render("staff/staff-bookmark", {
    staff,
    profileImageUrl: staff?.profileImage || null,
    profileFrame: staff?.profileFrame || null,
    coinCount: staff?.coins || 0,
    membership: staff?.membership || null,
    bookmarks: novels
  });
});

router.post('/staff/bookmark/remove', async (req, res) => {
  if (!req.session.staffId) return res.redirect("/staff/login");
  const staffId = new ObjectId(req.session.staffId);
  const { novelId } = req.body;
  await db.get().collection('bookmarkS').deleteOne({ staffId, novelId: new ObjectId(novelId) });
  res.redirect('/staff/bookmarks');
});

router.get("/staff/list", async (req, res) => {
  try {
    const staffCol = db.get().collection("staff");
    const novelCol = db.get().collection("novels");
    let staff = await db.get().collection("staff").findOne({ _id: new ObjectId(req.session.staffId) });
    const staffDocs = await staffCol.find(
      {},
      { projection: { Username: 1, profileImage: 1, profileFrame: 1 } }
    ).toArray();

    const staffIds = staffDocs.map(s => s._id);

    // Count novels per staff in one go
    const counts = await novelCol.aggregate([
      { $match: { staffId: { $in: staffIds } } },
      { $group: { _id: "$staffId", count: { $sum: 1 } } }
    ]).toArray();
    const countMap = Object.fromEntries(counts.map(c => [String(c._id), c.count]));

    // Also fetch a few novels for preview per staff
    const staffList = [];
    for (const s of staffDocs) {
      const novels = await novelCol.find(
        { staffId: s._id },
        { projection: { _id: 1, title: 1, imageUrl: 1 } }
      )
      .sort({ _id: -1 })
      .limit(12)
      .toArray();
      

      staffList.push({
        id: s._id.toString(),
        name: s.Username || "Staff",
        profileImageUrl: s.profileImage || null,
        profileFrame: s.profileFrame || null,
        novelCount: countMap[String(s._id)] || 0,
        novels: novels.map(n => ({
          id: n._id.toString(),
          title: n.title || "Untitled",
          imageUrl: n.imageUrl || null
        }))
      });
    }

    res.render("staff/staff-list", {
      staff,
      profileImageUrl: staff?.profileImage || null,
      profileFrame: staff?.profileFrame || null,
      coinCount: typeof staff?.coins === "number" ? staff.coins : 0,
      membership: staff?.membership || null,
      staffList
    });
  } catch (err) {
    console.error("Staff list error:", err);
    res.status(500).send("Server error");
  }
});

router.get("/staff/profile/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send("Invalid staff id");

    const staffCol = db.get().collection("staff");
    const novelCol = db.get().collection("novels");
    const chaptersCol = db.get().collection("chapters");

    // fetch the staff being viewed
    const staffDoc = await staffCol.findOne(
      { _id: new ObjectId(id) },
      { projection: { Username: 1, profileImage: 1, profileFrame: 1, kofi: 1, patreon: 1, coins: 1 } }
    );
    if (!staffDoc) return res.status(404).send("Staff not found");

    // fetch novels for that staff
    const novelsRaw = await novelCol
      .find({ staffId: staffDoc._id })
      .sort({ _id: -1 })
      .limit(200)
      .project({ _id: 1, title: 1, imageUrl: 1 })
      .toArray();

    // count novels for this staff
    const novelCount = await novelCol.countDocuments({ staffId: staffDoc._id });

    // attach chapter counts per novel
    if (novelsRaw.length) {
      const novelIds = novelsRaw.map(n => n._id);
      const counts = await chaptersCol.aggregate([
        { $match: { novelId: { $in: novelIds } } },
        { $group: { _id: "$novelId", count: { $sum: 1 } } }
      ]).toArray();
      const countMap = new Map(counts.map(c => [String(c._id), c.count]));
      novelsRaw.forEach(n => { n.chapters = countMap.get(String(n._id)) || 0; });
    }

    // fetch and normalize current viewer (if signed in)
    let viewer = null;
    if (req.session?.staffId) {
      const v = await staffCol.findOne(
        { _id: new ObjectId(req.session.staffId) },
        { projection: { Username: 1, profileImage: 1, profileFrame: 1, coins: 1 } }
      );
      if (v) {
        viewer = {
          _id: String(v._id),
          Username: v.Username,
          profileImageUrl: v.profileImage || null,
          profileFrame: v.profileFrame || null,
          coins: typeof v.coins === "number" ? v.coins : 0
        };
      }
    }

    res.render("staff/staff-profile-detailed", {
      name: staffDoc.Username,
      profileImageUrl: staffDoc.profileImage || null,
      profileFrame: staffDoc.profileFrame || null,
      kofi: staffDoc.kofi || null,
      patreon: staffDoc.patreon || null,
      novels: novelsRaw.map(n => ({ id: n._id.toString(), title: n.title, imageUrl: n.imageUrl || null, chapters: n.chapters || 0 })),
      staffId: id,
      novelCount,
      coinCount: viewer?.coins || 0,
      viewer,        
      now: Date.now(),
      success: req.flash('success'),
      error: req.flash('error')
    });
  } catch (err) {
    console.error("Profile detailed error:", err);
    res.status(500).send("Server error");
  }
});

// Novel detail
router.get("/novelS/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).send("Invalid novel ID");

    const staff = req.session.staffId
      ? await db.get().collection("staff").findOne({ _id: new ObjectId(req.session.staffId) })
      : null;

    const viewerId = staff?._id?.toString() || null;
    const isAdmin = staff?.role === "admin"; // or role check per your schema

    const novel = await db.get().collection("novels").findOne(
      { _id: new ObjectId(id) },
      { projection: { title:1, author:1, categ:1, description:1, status:1, audience:1, orglang:1, tralang:1, imageUrl:1, staff:1 } }
    );
    if (!novel) return res.status(404).send("Novel not found");

    const chaptersCollection = db.get().collection("chapters");
    const chapterCount = await chaptersCollection.countDocuments({ novelId: novel._id });

    // Fetch comments linked to this novel
    const commentsCol = db.get().collection("comments");
    const comments = await commentsCol
      .find({ novelId: novel._id })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    const viewComments = comments.map(c => {
      const ownerId = c.userId?.toString() || c.staffId?.toString() || null;
      return {
        _id: c._id.toString(),
        username: c.username || "Reader",
        profileImageUrl: c.profileImageUrl || null,
        profileFrame: c.profileFrame || null, // <-- FIXED!
        content: c.content,
        createdDate: new Date(c.createdAt).toLocaleString(),
        canDelete: isAdmin || (viewerId && ownerId && viewerId === ownerId)
      };
    });

    res.render("staff/novel-detail-staff", {
      staff,
      profileImageUrl: staff?.profileImage || null,
      profileFrame: staff?.profileFrame || null,
      coinCount: staff?.coins || 0,
      membership: staff?.membership || null,
      _id: novel._id.toString(),
      title: novel.title,
      author: novel.author,
      categ: novel.categ,
      description: novel.description,
      chapters: chapterCount,
      status: novel.status,
      audience: novel.audience,
      orglang: novel.orglang,
      tralang: novel.tralang,
      imageUrl: novel.imageUrl,
      staffName: novel.staff,
      comments: viewComments,
      canComment: Boolean(staff?._id)
    });
  } catch (err) {
    console.error("Staff novel detail error:", err);
    res.status(500).send("Server error");
  }
});

// Staff posts a comment
router.post("/novelS/:id/comments", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).send("Invalid novel ID");
    if (!req.session.staffId) return res.status(401).send("Login required");

    const staff = await db.get().collection("staff").findOne({ _id: new ObjectId(req.session.staffId) });
    if (!staff) return res.status(401).send("Login required");

    let content = (req.body.content || "").toString().trim();
    if (content.length < 2) return res.status(400).send("Comment too short");
    if (content.length > 2000) content = content.slice(0, 2000);

    const doc = {
      novelId: new ObjectId(id),
      staffId: staff._id,                 // mark author is staff
      userId: null,                       // optional for clarity
      username: staff.Username || "Staff",
      profileImageUrl: staff.profileImage || null,
      profileFrame: staff?.profileFrame || null,
      content,
      createdAt: new Date()
    };
    await db.get().collection("comments").insertOne(doc);

    res.redirect(`/novelS/${id}#rd-comments`);
  } catch (err) {
    console.error("Staff add comment error:", err);
    res.status(500).send("Server error");
  }
});

// Staff deletes a comment (own or admin)
router.post("/novelS/:novelId/comments/:commentId/delete", async (req, res) => {
  try {
    const { novelId, commentId } = req.params;
    if (!ObjectId.isValid(novelId) || !ObjectId.isValid(commentId)) return res.status(400).send("Invalid id");
    if (!req.session.staffId) return res.status(401).send("Login required");

    const staffId = new ObjectId(req.session.staffId);
    const commentsCol = db.get().collection("comments");

    const comment = await commentsCol.findOne({ _id: new ObjectId(commentId), novelId: new ObjectId(novelId) });
    if (!comment) return res.status(404).send("Not found");

    const staff = await db.get().collection("staff").findOne({ _id: staffId }, { projection: { role: 1 } });
    const isOwner = String(comment.staffId || "") === String(staffId);
    const isAdmin = staff?.role === "admin";
    if (!isOwner && !isAdmin) return res.status(403).send("Not allowed");

    await commentsCol.deleteOne({ _id: comment._id });

    res.redirect(`/novelS/${novelId}#rd-comments`);
  } catch (e) {
    console.error("Staff delete comment error:", e);
    res.status(500).send("Server error");
  }
});


// Chapter reader
router.get("/novelS/:id/read/:chapterId?", async (req, res) => {
  try {
    const novelId = req.params.id;
    const chapterId = req.params.chapterId || null;

    if (!ObjectId.isValid(novelId)) return res.status(400).send("Invalid novel id");

    const novelsCol = db.get().collection("novels");
    const chaptersCol = db.get().collection("chapters");
    const purchasesCol = db.get().collection("purchases");

    const novel = await novelsCol.findOne({ _id: new ObjectId(novelId) });
    if (!novel) return res.status(404).send("Novel not found");

    const now = new Date();

    // Fetch all chapters for navigation
    const all = await chaptersCol.find({ novelId: novel._id })
      .project({ _id: 1, title: 1, chapterNumber: 1, scheduleDate: 1, content: 1 })
      .sort({ chapterNumber: 1 })
      .toArray();

    // Find chapter
    let chapter = null;
    if (chapterId) {
      if (!ObjectId.isValid(chapterId)) return res.status(400).send("Invalid chapter id");
      chapter = await chaptersCol.findOne({ _id: new ObjectId(chapterId), novelId: novel._id });
      if (!chapter) return res.status(404).send("Chapter not found");
    } else {
      // First unlocked or first chapter
      chapter = await chaptersCol.find({
        novelId: novel._id,
        $or: [
          { scheduleDate: { $exists: false } },
          { scheduleDate: null },
          { scheduleDate: { $lte: now } }
        ]
      }).sort({ chapterNumber: 1 }).limit(1).next();
      if (!chapter && all.length) chapter = all[0];
      if (!chapter) {
        return res.status(200).render("staff/staff-reader", {
          novel,
          currentChapter: null,
          prevChapter: null,
          nextChapter: null,
          allChapters: []
        });
      }
    }

    // Get all unlocked chapter ids for this staff
    let unlockedIds = [];
    if (req.session?.staffId) {
      const purchases = await purchasesCol.find({
        staffId: new ObjectId(req.session.staffId),
        chapterId: { $in: all.map(c => c._id) }
      }).toArray();
      unlockedIds = purchases.map(p => String(p.chapterId));
    }

    // For chapter list
    const allChapters = all.map(c => {
      const cSd = c.scheduleDate ? new Date(c.scheduleDate) : null;
      const cScheduledFuture = cSd && now < cSd;
      // Always compare as string!
      const cUnlocked = unlockedIds.includes(String(c._id));
      return {
        _id: String(c._id),
        title: c.title,
        chapterNumber: c.chapterNumber,
        scheduleDate: cSd ? cSd.toISOString().slice(0,10) : null,
        locked: cScheduledFuture && !cUnlocked,
        current: String(c._id) === String(chapter._id)
      };
    });

    // Is current chapter scheduled for future?
    const sd = chapter.scheduleDate ? new Date(chapter.scheduleDate) : null;
    const isScheduledFuture = sd && now < sd;
    const isUnlocked = unlockedIds.includes(String(chapter._id));
    const isLocked = isScheduledFuture && !isUnlocked;

    // Prev/next chapters
    const idx = all.findIndex(c => String(c._id) === String(chapter._id));
    const prevChapterFull = idx > 0 ? allChapters[idx - 1] : null;
    const nextChapterFull = (idx >= 0 && idx < allChapters.length - 1) ? allChapters[idx + 1] : null;

    const prevChapter = prevChapterFull ? {
      _id: String(prevChapterFull._id),
      chapterNumber: prevChapterFull.chapterNumber,
      locked: prevChapterFull.locked
    } : null;

    const nextChapter = nextChapterFull ? {
      _id: String(nextChapterFull._id),
      chapterNumber: nextChapterFull.chapterNumber,
      locked: nextChapterFull.locked
    } : null;

    if (isLocked) {
      return res.status(200).render("staff/staff-reader", {
        novel,
        currentChapter: {
          _id: String(chapter._id),
          title: chapter.title,
          chapterNumber: chapter.chapterNumber,
          content: null,
          locked: true,
          unlockDate: sd ? sd.toISOString().slice(0,10) : null,
          unlockCost: 10
        },
        prevChapter,
        nextChapter,
        allChapters,
        now: Date.now()
      });
    }

    // Unlocked path
    res.status(200).render("staff/staff-reader", {
      novel,
      currentChapter: {
        _id: String(chapter._id),
        title: chapter.title,
        chapterNumber: chapter.chapterNumber,
        content: chapter.content || ''
      },
      prevChapter,
      nextChapter,
      allChapters,
      now: Date.now()
    });
  } catch (err) {
    console.error("Reader error:", err);
    res.status(500).send("Server error");
  }
});

router.post("/staff/chapters/:chapterId/unlock", async (req, res) => {
  try {
    if (!req.session?.staffId) {
      return res.status(401).json({ ok: false, msg: "Login required" });
    }
    const staffId = new ObjectId(req.session.staffId);
    const { chapterId } = req.params;
    const cost = Math.max(1, parseInt((req.body?.cost ?? 10), 10));

    if (!ObjectId.isValid(chapterId)) {
      return res.status(400).json({ ok: false, msg: "Invalid chapter id" });
    }

    const dbi = db.get();
    const staffCol = dbi.collection("staff");
    const chaptersCol = dbi.collection("chapters");
    const purchasesCol = dbi.collection("purchases");

    // Ensure chapter exists
    const chapter = await chaptersCol.findOne({ _id: new ObjectId(chapterId) }, { projection: { _id: 1 } });
    if (!chapter) return res.status(404).json({ ok: false, msg: "Chapter not found" });

    // Already unlocked?
    const already = await purchasesCol.findOne({ staffId, chapterId: chapter._id });
    if (already) {
      return res.status(200).json({ ok: true, msg: "Already unlocked" });
    }

    // Atomically deduct coins if enough
    const staffDoc = await staffCol.findOneAndUpdate(
      { _id: staffId, coins: { $gte: cost } },
      { $inc: { coins: -cost } },
      { returnDocument: "after" }
    );
    

    // Record unlock. If this insert somehow fails, refund coins.
    try {
      await purchasesCol.insertOne({
        staffId,
        chapterId: chapter._id,
        cost,
        at: new Date()
      });
    } catch (e) {
      // Refund on failure
      await staffCol.updateOne({ _id: staffId }, { $inc: { coins: cost } });
      return res.status(500).json({ ok: false, msg: "Failed to record unlock" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("unlock error:", err);
    return res.status(500).json({ ok: false, msg: "Server error" });
  }
});

// STAFF SHOP
router.get("/staff-shop", async (req, res) => {
  if (!req.session.staffId) {
    return res.redirect("/staff/login");
  }
  try{
    let staff = await db.get().collection("staff").findOne({ _id: new ObjectId(req.session.staffId) });
    // await db.get().collection("staff").updateOne(
    //   { _id: staff._id },
    //   { $set: { "plan.name": "Free", "plan.expires": null, "profileFrame": null } }
    // );
    // staff.profileFrame = null;
    const profileLinks = {
      home: "/staff",
      profile: "/staff/profile",
      logout: "/logout"
    };
    const coinCount = staff?.coins || 0;

    res.render("staff/staff-shop", {
      staff,
      profileImageUrl: staff?.profileImage || null,
      profileFrame: staff?.profileFrame || null,
      coinCount: typeof staff?.coins === "number" ? staff.coins : 0,
      membership: staff?.membership || null
    });
  } catch (err) {
    console.error("Staff home error:", err);
    res.redirect("/staff/login");
  }
});

//coin purchase
router.post('/staff/coins/purchase', async (req, res) => {
  try {
    if (!req.session.staffId) return res.status(401).json({ success: false, message: "Login required" });
    const staffId = new ObjectId(req.session.staffId);
    const { amount } = req.body;
    const coins = parseInt(amount);

    if (![20, 50, 100, 300, 500, 2000].includes(coins)) {
      return res.status(400).json({ success: false, message: "Invalid coin amount" });
    }

    await db.get().collection("staff").updateOne(
      { _id: staffId },
      { $inc: { coins } }
    );

    await db.get().collection('coin_transactions').insertOne({
      userType: 'staff',
      staffId,
      type: 'coin_purchase',
      amount: coins,
      status: 'success',
      paymentMethod: 'paypal',
      createdAt: new Date()
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Staff coin purchase error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Grant silver Quill Membership to staff
router.post('/membership/silver/grantstaff', async (req, res) => {
  try {
    if (!req.session.staffId) return res.status(401).json({ ok: false, msg: 'Login required' });
    const staffId = new ObjectId(req.session.staffId);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db.get().collection("staff").updateOne(
      { _id: new ObjectId(staffId) },
      {
        $set: {
          "plan.name": "Silver Quill",
          "plan.expires": expiresAt,
          "profileFrame": "silver"
        },
        $inc: { coins: 60 }
      }
    );

    await db.get().collection('coin_transactions').insertOne({
      userType: 'staff',
      staffId,
      type: 'membership_silver_bonus',
      amount: 60,
      status: 'success',
      paymentMethod: 'paypal',
      createdAt: new Date()
    });

    return res.json({ ok: true, expiresAt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, msg: 'Failed to grant' });
  }
});

// Grant Golden Tome Membership to staff
router.post('/membership/gold/grantstaff', async (req, res) => {
  console.log("Session at membership grant:", req.session);
  try {
    if (!req.session.staffId) return res.status(401).json({ ok: false, msg: 'Login required' });
    const staffId = new ObjectId(req.session.staffId);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db.get().collection("staff").updateOne(
      { _id: new ObjectId(staffId) },
      {
        $set: {
          "plan.name": "Golden Tome",
          "plan.expires": expiresAt,
          "profileFrame": "gold"
        },
        $inc: { coins: 120 }
      }
    );

    await db.get().collection('coin_transactions').insertOne({
      userType: 'staff',
      staffId,
      type: 'membership_gold_bonus',
      amount: 120,
      status: 'success',
      paymentMethod: 'paypal',
      createdAt: new Date()
    });

    return res.json({ ok: true, expiresAt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, msg: 'Failed to grant' });
  }
});

// Grant Obsidian Edition Membership to staff
router.post('/membership/obsidian/grantstaff', async (req, res) => {
  console.log("Session at membership grant:", req.session);
  try {
    if (!req.session.staffId) return res.status(401).json({ ok: false, msg: 'Login required' });
    const staffId = new ObjectId(req.session.staffId);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    console.log("staffId:", staffId);
    const staff = await db.get().collection("staff").findOne({ _id: new ObjectId(staffId) });
    console.log("Staff found:", staff);

    const result = await db.get().collection("staff").updateOne(
    { _id: new ObjectId(staffId) },
    {
      $set: {
        "plan.name": "Obsidian Edition",
        "plan.expires": expiresAt,
        "profileFrame": "obsidian"
      },
      $inc: { coins: 300 }
    }
  );
  console.log(result);

    await db.get().collection('coin_transactions').insertOne({
      userType: 'staff',
      staffId,
      type: 'membership_obsidian_bonus',
      amount: 300,
      status: 'success',
      paymentMethod: 'paypal',
      createdAt: new Date()
    });

    return res.json({ ok: true, expiresAt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, msg: 'Failed to grant' });
  }
});

// Staff profile
router.get("/staff/profile", async (req, res) => {
  if (!req.session.staffId) {
    return res.redirect("/staff/login");
  }
  const staff = await db.get().collection("staff").findOne({ _id: new ObjectId(req.session.staffId) });
  res.render("staff/staff-profile", {
    staff,
    profileImageUrl: staff?.profileImage || null,
    profileFrame: staff?.profileFrame || null,
    plan: staff.plan || { name: "Free", expires: null },
    coinCount: (typeof staff?.coins === "number" ? staff.coins : 0)
  });
});

router.post('/staff/profile/edit', async (req, res) => {
  try {
    const staffIdRaw = req.session?.staffId;
    if (!staffIdRaw) return res.status(401).json({ error: "Not logged in" });

    const staffId = new ObjectId(staffIdRaw);
    const staffCollection = db.get().collection('staff');
    const staff = await staffCollection.findOne({ _id: staffId });
    if (!staff) return res.status(404).json({ error: "staff not found" });

    const update = {};

    // Normalize username inputs
  const incomingRaw = req.body?.Username ?? '';
  const incoming = String(incomingRaw).trim();
  const current = String(staff.Username ?? '').trim();
  
  if (incoming && incoming !== current) {
    const now = Date.now();
    const lastChange = staff.lastUsernameChange ? new Date(staff.lastUsernameChange).getTime() : 0;
    // Membership-based window: 7 days if membership exists and is active; else 30 days
    const hasActiveMembership = !!(staff.membership && staff.membership.status === 'active');
    const renameWindowDays = hasActiveMembership ? 7 : 30;
    const renameWindowMs = renameWindowDays * 24 * 60 * 60 * 1000;

    if (lastChange && (now - lastChange < renameWindowMs)) {
      const remainingMs = renameWindowMs - (now - lastChange);
      const remainingDays = Math.ceil(remainingMs / (24*60*60*1000));
      return res.status(400).json({
        error: `Username can only be changed once every ${renameWindowDays} days. Try again in ~${remainingDays} day(s).`
      });
    }

    const exists = await staffCollection.findOne({ Username: incoming, _id: { $ne: staffId } });
    if (exists) return res.status(400).json({ error: "Username already exists." });

    update.Username = incoming;
    update.lastUsernameChange = now;
  }
    // If incoming is blank or equal to current, skip username update entirely

    // Image upload stays the same
    if (req.files && req.files.profileImage) {
      const image = req.files.profileImage;
      const uploadsDir = path.join(__dirname, '../public/images/profile-images/');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const filename = Date.now() + '-' + image.name.replace(/\s+/g, '_');
      const uploadPath = path.join(uploadsDir, filename);
      await image.mv(uploadPath);
      update.profileImage = `../public/images/profile-images/${filename}`;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No changes detected." });
    }

    await staffCollection.updateOne({ _id: staffId }, { $set: update });
    if (update.Username) req.session.staff = update.Username;

    return res.json({ success: true });
  } catch (err) {
    console.error("Server error:", err.stack);
    return res.status(500).json({ error: "Server crashed during profile update." });
  }
});

router.post("/staff/profile/remove-photo", async (req, res) => {
  const staffId = req.session.staffId;
  await db.get().collection("staff").updateOne(
    { _id: new ObjectId(staffId) },
    { $set: { profileImage: null } }
  );
  res.json({ success: true });
});


// Staff Dashboard with Novels
router.get("/staff/dash", async (req, res) => {
  if (!req.session.staffId) return res.redirect("/staff/login");

  try {
    const staffId = new ObjectId(req.session.staffId);
    const staff = await db.get().collection("staff").findOne(
      { _id: staffId },
      { projection: { Username: 1, profileImage: 1 } }
    );

    // Novels (existing logic)
    const page = parseInt(req.query.page) || 1;
    const limit = 4;
    const skip = (page - 1) * limit;

    const novelsCollection = db.get().collection("novels");
    const totalNovels = await novelsCollection.countDocuments({ staffId });
    const novels = await novelsCollection.find({ staffId }).skip(skip).limit(limit).toArray();

    const chaptersCollection = db.get().collection("chapters");
    for (let novel of novels) {
      novel.chapters = await chaptersCollection.countDocuments({ novelId: novel._id });
    }

    // COMMENTS for this staff's novels
    const myNovelsAll = await novelsCollection.find(
      { staffId },
      { projection: { _id: 1, title: 1, imageUrl: 1 } }
    ).toArray();
    const novelIds = myNovelsAll.map(n => n._id);

    let staffComments = [];
    if (novelIds.length) {
      const commentsCol = db.get().collection("comments");

      // Optional separate pagination for comments
      const cPage = Math.max(1, parseInt(req.query.cpage || "1", 10));
      const cLimit = 100;
      const cSkip = (cPage - 1) * cLimit;

      const rawComments = await commentsCol.aggregate([
        { $match: { novelId: { $in: novelIds } } },
        { $sort: { createdAt: -1 } },
        { $skip: cSkip },
        { $limit: cLimit },
        { $lookup: {
            from: "novels",
            localField: "novelId",
            foreignField: "_id",
            as: "novel"
        }},
        { $unwind: "$novel" },
        { $project: {
            _id: 1,
            novelId: 1,
            content: 1,
            username: 1,
            profileImageUrl: 1,
            createdAt: 1,
            "novel._id": 1,
            "novel.title": 1,
            "novel.imageUrl": 1
        }}
      ]).toArray();

      // Group by novel
      const byNovel = {};
      for (const c of rawComments) {
        const nid = c.novelId.toString();
        if (!byNovel[nid]) {
          // find novel from myNovelsAll fallback to lookup doc
          const nov = myNovelsAll.find(n => String(n._id) === nid) || c.novel || {};
          byNovel[nid] = {
            novelId: nid,
            title: nov.title || "Untitled",
            imageUrl: nov.imageUrl || null,
            comments: []
          };
        }
        byNovel[nid].comments.push({
          _id: c._id.toString(),
          username: c.username || "Reader",
          profileImageUrl: c.profileImageUrl || null,
          content: c.content,
          createdDate: new Date(c.createdAt).toLocaleString()
        });
      }
      staffComments = Object.values(byNovel);
    }

    res.render("staff/staff-dash", {
      staff: staff?.Username,
      profileImageUrl: staff?.profileImage || null,

      novels,
      currentPage: page,
      totalPages: Math.ceil(totalNovels / limit),
      hasNovels: novels.length > 0,

      // Comments tab data
      staffComments
      // Optionally: cPage, cTotalPages
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.redirect("/staff/login");
  }
});

router.post("/staff/profile/supportlinks", async (req, res) => {
  try {
    if (!req.session?.staffId) return res.status(401).json({ ok: false, msg: "Login required" });

    // Accept JSON or form-encoded
    const bio = (req.body.bio || "").toString().trim();
    const kofi = (req.body.kofi || "").toString().trim();
    const patreon = (req.body.patreon || "").toString().trim();

    // basic validation
    if (bio.length > 1000) return res.status(400).json({ ok: false, msg: "Bio too long" });
    if (kofi.length > 300 || patreon.length > 300) return res.status(400).json({ ok: false, msg: "URL too long" });

    const staffId = new ObjectId(String(req.session.staffId));
    const staffCol = db.get().collection("staff");

    await staffCol.updateOne(
      { _id: staffId },
      { $set: { bio: bio || null, kofi: kofi || null, patreon: patreon || null } }
    );

    return res.json({ ok: true, msg: "Profile updated" });
  } catch (err) {
    console.error("Support links update error:", err);
    return res.status(500).json({ ok: false, msg: "Server error" });
  }
});

// Add New Novel Form
router.get("/staff/novels/add", async (req, res) => {
  if (!req.session.staffId) {
    return res.redirect("/staff/login");
  }
  const staff = await db.get().collection("staff").findOne({
    _id: new ObjectId(req.session.staffId)
  });
  res.render("staff/add-novel", {
    staff,
    coinCount: typeof staff?.coins === "number" ? staff.coins : 0,
    profileImageUrl: staff?.profileImage || null,
    profileFrame: staff?.profileFrame || null,
  });
});

// Handle Novel Creation
router.post("/staff/novels", async (req, res) => {
  if (!req.session.staffId) {
    return res.redirect("/staff/login");
  }

  try {
    const {
      title, author, description, chapters, category, status, audience,
      originalLanguage, translatedLanguage, hashtags
    } = req.body;

    if (!title || !author) {
      return res.status(400).json({ error: "Details are required" });
    }

    const novelData = {
      title,
      chapters: parseInt(chapters) || 0,
      status: status || "Ongoing",
      author: author || "Unknown",
      categ: category,
      tag: hashtags || "",
      orglang: originalLanguage,
      tralang: translatedLanguage,
      description: description || "No description provided",
      staff: req.session.Staff || "Unknown",
      audience: audience || "Everyone",
      staffId: new ObjectId(req.session.staffId),
      createdAt: new Date(),
      updatedAt: new Date()
    }

    if (req.files && req.files.image) {
      const coverId = await uploadNovelCover(req.files.image);
      novelData.imageUrl = `../public/images/novel-images/${coverId}`;
    } else {
      novelData.imageUrl = '../public/images/novel-images/novel_dummy.png';
    }

    await db.get().collection("novels").insertOne(novelData);

    res.redirect("/staff/dash");
  } catch (error) {
    console.error("Error adding novel:", error);
    res.status(500).render("staff/add-novel", {
      error: "Failed to add novel. Please try again."
    });
  }
});

// Edit Novel Form
router.get("/staff/novels/:id/edit", async (req, res) => {
  if (!req.session.staffId) {
    return res.redirect("/staff/login");
  }

  try {
    const novel = await db.get().collection("novels").findOne({
      _id: new ObjectId(req.params.id),
      staffId: new ObjectId(req.session.staffId)
    });
    const staff = await db.get().collection("staff").findOne({
      _id: new ObjectId(req.session.staffId)
    });

    if (!novel) {
      return res.status(404).render("error", { message: "Novel not found" });
    }

    let tagsArray = [];
    if (Array.isArray(novel.tag)) {
      tagsArray = novel.tag;
    } else if (typeof novel.tag === "string" && novel.tag) {
      tagsArray = novel.tag.split(",").map(t => t.trim()).filter(Boolean);
    }

    const chaptersCount = await db.get().collection("chapters").countDocuments({
      novelId: new ObjectId(req.params.id)
    });

    console.log("Tags being sent to template:", tagsArray.join(","));

    res.render("staff/edit-novel", {
      staff,
      novel: { ...novel, tags: tagsArray.join(",") },
      coinCount: typeof staff?.coins === "number" ? staff.coins : 0,
      profileImageUrl: staff?.profileImage || null,
      profileFrame: staff?.profileFrame || null,
      chaptersCount
    });
  } catch (error) {
    console.error("Error fetching novel:", error);
    res.redirect("/staff/dash");
  }
});

// Update Novel
router.post("/staff/novels/:id", async (req, res) => {
  if (!req.session.staffId) {
    return res.redirect("/staff/login");
  }

  try {
    const {
      title, author, description, chapters, status, hashtags, audience,
      category, originalLanguage, translatedLanguage
    } = req.body;

    const updateData = {
      title,
      chapters: parseInt(chapters) || 0,
      status: status || "Ongoing",
      author: author || "Unknown",
      categ: category,
      tag: hashtags || "",
      orglang: originalLanguage,
      tralang: translatedLanguage,
      description: description || "No description provided",
      staff: req.session.Staff || "Unknown",
      audience: audience || "Everyone",
      updatedAt: new Date()
    };

    if (req.files && req.files.cover) {
      const coverId = await uploadNovelCover(req.files.cover);
      updateData.imageUrl = `../public/images/novel-images/${coverId}`;
    }

    await db.get().collection("novels").updateOne(
      { _id: new ObjectId(req.params.id), staffId: new ObjectId(req.session.staffId) },
      { $set: updateData }
    );

    res.redirect("/staff/dash");
  } catch (error) {
    console.error("Error updating novel:", error);
    res.redirect(`/staff/novels/${req.params.id}/edit`);
  }
});

// Delete Novel
router.post("/staff/novels/:id/delete", async (req, res) => {
  if (!req.session.staffId) {
    return res.redirect("/staff/login");
  }

  try {
    await db.get().collection("novels").deleteOne({
      _id: new ObjectId(req.params.id),
      staffId: new ObjectId(req.session.staffId)
    });

    res.redirect("/staff/dash");
  } catch (error) {
    console.error("Error deleting novel:", error);
    res.redirect("/staff/dash");
  }
});

// Add new chapter form
router.get("/staff/novels/add-ch", async (req, res) => {
  if (!req.session.staffId) {
    return res.redirect("/staff/login");
  }
  const staff = await db.get().collection("staff").findOne({
    _id: new ObjectId(req.session.staffId)
  });
  const novelId = req.query.novelId;
  res.render("staff/add-chapter", {
    novel: { _id: novelId },
    staff,
    coinCount: typeof staff?.coins === "number" ? staff.coins : 0,
    profileImageUrl: staff?.profileImage || null,
    profileFrame: staff?.profileFrame || null,

  });
});

// Add Chapter (AJAX)
router.post("/staff/novels/:novelId/chapters", async (req, res) => {
  try {
    if (!req.session.staffId) return res.status(401).json({ error: "Login required" });

    const { novelId } = req.params;
    if (!ObjectId.isValid(novelId)) return res.status(400).json({ error: "Invalid novel ID" });

    // accept scheduleDate from body
    const { chapterNumber, title, html, scheduleDate } = req.body;
    const num = Number(chapterNumber || 0);

    if (!num || !html || !html.trim()) {
      return res.status(400).json({ error: "Chapter number and content required" });
    }

    // optional: ensure novel exists and is owned by current staff
    const novel = await db.get().collection("novels").findOne({
      _id: new ObjectId(novelId),
      staffId: new ObjectId(req.session.staffId)
    });
    if (!novel) return res.status(403).json({ error: "Novel not found or not owned by you" });

    let scheduleAt = null;
    if (scheduleDate) {
      const d = new Date(scheduleDate);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: "Invalid schedule date" });
      }
      scheduleAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }

    await db.get().collection("chapters").insertOne({
      novelId: new ObjectId(novelId),
      chapterNumber: num,
      title: title || "No title",
      content: html,
      publishedAt: new Date(),
      scheduleDate: scheduleAt
    });

    await db.get().collection("novels").updateOne(
      { _id: new ObjectId(novelId) },
      { $inc: { chapters: 1 } }
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Add chapter error:", err);
    res.status(500).json({ error: "Failed to add chapter" });
  }
});

// Get Chapters (AJAX)
router.get("/staff/novels/:novelId/chapters", async (req, res) => {
  try {
    const { novelId } = req.params;
    const chapters = await db.get().collection("chapters")
      .find({ novelId: new ObjectId(novelId) })
      .sort({ chapterNumber: 1 })
      .toArray();
    res.json(chapters);
  } catch (err) {
    res.status(500).json([]);
  }
});

// Edit chapter form
router.get("/staff/chapters/:id/edit", async (req, res) => {
  const staff = await db.get().collection("staff").findOne({
    _id: new ObjectId(req.session.staffId)
  });
  const chapterId = req.params.id;
  const chapter = await db.get().collection("chapters").findOne({ _id: new ObjectId(chapterId) });
  const novelId = chapter.novelId;
  res.render("staff/edit-chapter", {
    chapter,
    novel: { _id: novelId },
    staff,
    coinCount: typeof staff?.coins === "number" ? staff.coins : 0,
    profileImageUrl: staff?.profileImage || null,
    profileFrame: staff?.profileFrame || null,
  });
});

router.post("/staff/chapters/:id/edit", async (req, res) => {
  const chapterId = req.params.id;
  const { chapterNumber, title, html } = req.body;
  try {
    await db.get().collection("chapters").updateOne(
      { _id: new ObjectId(chapterId) },
      {
        $set: {
          chapterNumber: Number(chapterNumber),
          title: title || "No title",
          content: html,
          updatedAt: new Date()
        }
      }
    );
    const chapter = await db.get().collection("chapters").findOne({ _id: new ObjectId(chapterId) });
    res.redirect(`/staff/novels/${chapter.novelId}/edit`);
  } catch (err) {
    res.status(500).render("staff/edit-chapter", { error: "Failed to update chapter." });
  }
});

//chapter Unlock
router.post("/staff/chapters/:id/unlock", async (req, res) => {
  try {
    if (!req.session?.staffId) return res.status(401).json({ ok: false, msg: "Login required" });

    const chapterId = req.params.id;
    if (!ObjectId.isValid(chapterId)) return res.status(400).json({ ok: false, msg: "Invalid chapter id" });

    const cost = Number(req.body.cost) || 10;
    const chaptersCol = db.get().collection("chapters");
    const staffCol = db.get().collection("staff");
    const purchasesCol = db.get().collection("purchases");

    const chapter = await chaptersCol.findOne({ _id: new ObjectId(chapterId) });
    if (!chapter) return res.status(404).json({ ok: false, msg: "Chapter not found" });

    const now = new Date();
    const isScheduled = chapter.scheduleDate && new Date(chapter.scheduleDate) > now;
    if (!isScheduled) {
      return res.status(400).json({ ok: false, msg: "Chapter is already unlocked" });
    }

    // check already purchased
    const already = await purchasesCol.findOne({ chapterId: new ObjectId(chapterId), staffId: new ObjectId(req.session.staffId) });
    if (already) return res.json({ ok: true, msg: "Already unlocked" });

    // get staff coins, default to 0 if missing
    const staff = await staffCol.findOne({ _id: new ObjectId(req.session.staffId) });
    const coins = typeof staff?.coins === "number" ? staff.coins : 0;
    if (coins < cost) return res.status(400).json({ ok: false, msg: "Insufficient coins" });

    // atomic deduct staff coins
    const deduct = await staffCol.findOneAndUpdate(
      { _id: new ObjectId(req.session.staffId), coins: { $gte: cost } },
      { $inc: { coins: -cost } },
      { returnDocument: "after" }
    );
    if (!deduct.value) return res.status(400).json({ ok: false, msg: "Insufficient coins" });

    // record purchase
    await purchasesCol.insertOne({
      chapterId: new ObjectId(chapterId),
      staffId: new ObjectId(req.session.staffId),
      cost,
      createdAt: new Date()
    });

    return res.json({ ok: true, msg: "Unlocked" });
  } catch (err) {
    console.error("Chapter unlock error:", err);
    return res.status(500).json({ ok: false, msg: "Server error" });
  }
});

// Delete Chapter
router.post("/staff/novels/:novelId/chapters/:chapterId/delete", async (req, res) => {
  const { novelId, chapterId } = req.params;
  try {
    await db.get().collection("chapters").deleteOne({ _id: new ObjectId(chapterId) });
    await db.get().collection("novels").updateOne(
      { _id: new ObjectId(novelId) },
      { $inc: { chapters: -1 } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete chapter" });
  }
});

router.post("/staff/rewards/daily", async (req, res) => {
  try {
    if (!req.session.staffId) return res.status(401).json({ ok: false, error: "Login required" });

    const staffs = db.get().collection("staff");
    const sid = new ObjectId(req.session.staffId);

    const staff = await staffs.findOne({ _id: sid }, { projection: { coins: 1, lastDailyClaim: 1 } });
    if (!staff) return res.status(404).json({ ok: false, error: "staff not found" });

    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const last = staff.lastDailyClaim ? new Date(staff.lastDailyClaim) : null;
    const lastUTC = last ? new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate())) : null;

    if (lastUTC && lastUTC.getTime() === todayUTC.getTime()) {
      return res.status(200).json({ ok: true, claimed: false, coins: staff.coins || 0, message: "Already claimed today" });
    }

    const result = await staffs.findOneAndUpdate(
      {
        _id: sid,
        $expr: {
          $ne: [
            { $dateTrunc: { date: "$lastDailyClaim", unit: "day" } },
            { $dateTrunc: { date: now, unit: "day" } }
          ]
        }
      },
      { $inc: { coins: 1 }, $set: { lastDailyClaim: now } },
      { returnDocument: "after" }
    );

    // If race condition or first-time, fallback ensure
    const updated = result.value || await staffs.findOne({ _id: sid }, { projection: { coins: 1, lastDailyClaim: 1 } });

    return res.status(200).json({
      ok: true,
      claimed: true,
      coins: updated.coins || (staff.coins || 0) + 1,
      message: "Daily reward claimed"
    });
  } catch (err) {
    console.error("Daily reward error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;

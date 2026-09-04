// routes/user.js - For Readora (Book Reading App)
const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const { ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");
const db = require("../config/connection");
const crypto = require("crypto");

const DEFAULT_COVER_URL = "/images/novel-images/novel_dummy.png";

function startOfUTCDay(d){
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

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
      imageUrl: n.imageUrl || DEFAULT_COVER_URL,
      categ: n.categ || ''
    })));
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json([]);
  }
});

// Home
router.get("/", async (req, res) => {
  const user = req.session.userId
    ? await db.get().collection("user").findOne({ _id: new ObjectId(req.session.userId) })
    : null;

  const novelsCol = db.get().collection("novels");
  const chaptersCol = db.get().collection("chapters");

  // user novels (latest 10)
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

  res.render("user/home-user", {
    user,
    profileImageUrl: user?.profileImage || null,
    profileFrame: user?.profileFrame || null,
    coinCount: user?.coins || 0,
    membership: user?.membership || null,
    staffNovels,
    randomNovels,
    randomNovelsJson: JSON.stringify(randomNovels)
  });
});

// Add bookmark
router.post('/user/bookmark', async (req, res) => {
  if (!req.session.userId) return res.redirect("/user/login");
  const userId = new ObjectId(req.session.userId);
  const { novelId } = req.body;
  if (!novelId || !ObjectId.isValid(novelId)) return res.redirect("/user/bookmarks");

  const exists = await db.get().collection('bookmarkU').findOne({ userId, novelId: new ObjectId(novelId) });
  if (!exists) {
    await db.get().collection('bookmarkU').insertOne({
      userId,
      novelId: new ObjectId(novelId),
      createdAt: new Date()
    });
  }
  res.redirect('/user/bookmarks');
});

// Bookmarks page
router.get("/user/bookmarks", async (req, res) => {
  if (!req.session.userId) return res.redirect("/user/login");
  const userId = new ObjectId(req.session.userId);

  const user = await db.get().collection("user").findOne({ _id: userId });

  const bookmarks = await db.get().collection('bookmarkU').find({ userId }).toArray();
  const novelIds = bookmarks.map(b => b.novelId);

  let novels = novelIds.length
    ? await db.get().collection('novels').find({ _id: { $in: novelIds } }).toArray()
    : [];

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

  res.render("user/user-bookmark", {
    user,
    profileImageUrl: user?.profileImage || null,
    profileFrame: user?.profileFrame || null,
    coinCount: user?.coins || 0,
    membership: user?.membership || null,
    bookmarks: novels
  });
});

// Remove bookmark
router.post('/user/bookmark/remove', async (req, res) => {
  if (!req.session.userId) return res.redirect("/user/login");
  const userId = new ObjectId(req.session.userId);
  const { novelId } = req.body;
  if (novelId && ObjectId.isValid(novelId)) {
    await db.get().collection('bookmarkU').deleteOne({ userId, novelId: new ObjectId(novelId) });
  }
  res.redirect('/user/bookmarks');
});

router.get("/staffs/list", async (req, res) => {
  try {
    const staffCol = db.get().collection("staff");
    const novelCol = db.get().collection("novels");
    let user = await db.get().collection("user").findOne({ _id: new ObjectId(req.session.userId) });
    const staffDocs = await staffCol.find(
      {},
      { projection: { Username: 1, profileImage: 1, profileFrame: 1 } }
    ).toArray();

    const staffIds = staffDocs.map(s => s._id);

    // Count novels per user in one go
    const counts = await novelCol.aggregate([
      { $match: { staffId: { $in: staffIds } } },
      { $group: { _id: "$staffId", count: { $sum: 1 } } }
    ]).toArray();
    const countMap = Object.fromEntries(counts.map(c => [String(c._id), c.count]));

    // Also fetch a few novels for preview per user
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
          imageUrl: n.imageUrl || DEFAULT_COVER_URL
        }))
      });
    }

    res.render("user/staffs-list", {
      user,
      profileImageUrl: user?.profileImage || null,
      profileFrame: user?.profileFrame || null,
      coinCount: typeof user?.coins === "number" ? user.coins : 0,
      membership: user?.membership || null,
      staffList
    });
  } catch (err) {
    console.error("Staff list error:", err);
    res.status(500).send("Server error");
  }
});

router.get("/staffs/profile/:id", async (req, res) => {
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
    if (req.session?.userId) {
      const userCol = db.get().collection("user");
      const v = await userCol.findOne(
        { _id: new ObjectId(req.session.userId) },
        { projection: { Username: 1, profileImage: 1, profileFrame: 1, coins: 1 } }
      );
      console.log("viewer fetch:", req.session.userId, !!v);
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

    res.render("user/staffs-profile-detailed", {
      name: staffDoc.Username,
      profileImageUrl: staffDoc.profileImage || null,
      profileFrame: staffDoc.profileFrame || null,
      kofi: staffDoc.kofi || null,
      patreon: staffDoc.patreon || null,
      novels: novelsRaw.map(n => ({ id: n._id.toString(), title: n.title, imageUrl: n.imageUrl || DEFAULT_COVER_URL, chapters: n.chapters || 0 })),
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
router.get("/novel/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).send("Invalid novel ID");

    const user = req.session.userId
      ? await db.get().collection("user").findOne({ _id: new ObjectId(req.session.userId) })
      : null;

    const viewerId = user?._id?.toString() || null;
    const isAdmin = user?.role === "admin";

    const novelsCol = db.get().collection("novels");
    const novel = await novelsCol.findOne(
      { _id: new ObjectId(id) },
      { projection: { title:1, author:1, categ:1, description:1, status:1, audience:1, orglang:1, tralang:1, imageUrl:1, staff:1 } }
    );
    if (!novel) return res.status(404).send("Novel not found");

    const chaptersCollection = db.get().collection("chapters");
    const chapterCount = await chaptersCollection.countDocuments({ novelId: novel._id });

    const commentsCol = db.get().collection("comments");
    const comments = await commentsCol
      .find({ novelId: novel._id })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    const viewComments = comments.map(c => {
      const ownerId = c.userId?.toString() || null;
      return {
        _id: c._id.toString(),
        username: c.username || "Reader",
        profileImageUrl: c.profileImageUrl || null,
        profileFrame: c.profileFrame || null,
        content: c.content,
        createdDate: new Date(c.createdAt).toLocaleString(),
        canDelete: isAdmin || (viewerId && ownerId && viewerId === ownerId)
      };
    });

    res.render("user/novel-detail-user", {
      user,
      profileImageUrl: user?.profileImage || null,
      profileFrame: user?.profileFrame || null,
      coinCount: user?.coins || 0,
      membership: user?.membership || null,
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
      imageUrl: novel.imageUrl || DEFAULT_COVER_URL,
      staff: novel.staff,
      comments: viewComments,
      canComment: Boolean(user?._id)
    });
  } catch (err) {
    console.error("Novel detail error:", err);
    res.status(500).send("Server error");
  }
});

// Post a comment
router.post("/novel/:id/comments", async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).send("Invalid novel ID");
    if (!req.session.userId) return res.status(401).send("Login required");

    const user = await db.get().collection("user").findOne({ _id: new ObjectId(req.session.userId) });
    if (!user) return res.status(401).send("Login required");

    let content = (req.body.content || "").toString().trim();
    if (!content || content.length < 2) return res.status(400).send("Comment too short");
    if (content.length > 2000) content = content.slice(0, 2000);

    const doc = {
      user,
      novelId: new ObjectId(id),
      userId: user._id,
      username: user.Username || "Reader",
      profileImageUrl: user.profileImage || null,
      profileFrame: user.profileFrame || null,
      content,
      createdAt: new Date()
    };
    await db.get().collection("comments").insertOne(doc);

    res.redirect(`/novel/${id}#rd-comments`);
  } catch (err) {
    console.error("Add comment error:", err);
    res.status(500).send("Server error");
  }
});

// Delete comment
router.post("/novel/:novelId/comments/:commentId/delete", async (req, res) => {
  try {
    const { novelId, commentId } = req.params;
    if (!ObjectId.isValid(novelId) || !ObjectId.isValid(commentId)) {
      return res.status(400).send("Invalid id");
    }
    if (!req.session.userId) {
      return res.status(401).send("Login required");
    }

    const userId = new ObjectId(req.session.userId);
    const commentsCol = db.get().collection("comments");

    const comment = await commentsCol.findOne({ _id: new ObjectId(commentId), novelId: new ObjectId(novelId) });
    if (!comment) return res.status(404).send("Not found");

    const user = await db.get().collection("user").findOne({ _id: userId }, { projection: { role: 1 } });
    const isOwner = String(comment.userId) === String(userId);
    const isAdmin = user?.role === "admin";
    if (!isOwner && !isAdmin) return res.status(403).send("Not allowed");

    await commentsCol.deleteOne({ _id: comment._id });

    res.redirect(`/novel/${novelId}#rd-comments`);
  } catch (e) {
    console.error("Delete comment error:", e);
    res.status(500).send("Server error");
  }
});

// Chapter reader
router.get("/novel/:id/read/:chapterId?", async (req, res) => {
  try {
    const novelId = req.params.id;
    const chapterId = req.params.chapterId || null;

    if (!ObjectId.isValid(novelId)) return res.status(400).send("Invalid novel ID");

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
        return res.status(200).render("user/user-reader", {
          novel,
          currentChapter: null,
          prevChapter: null,
          nextChapter: null,
          allChapters: []
        });
      }
    }

    // Get all unlocked chapter ids for this user
    let unlockedIds = [];
    if (req.session?.userId) {
      const purchases = await purchasesCol.find({
        userId: new ObjectId(req.session.userId),
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
    const ud = chapter.scheduleDate ? new Date(chapter.scheduleDate) : null;
    const isScheduledFuture = ud && now < ud;
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
      return res.status(200).render("user/user-reader", {
        novel,
        currentChapter: {
          _id: String(chapter._id),
          title: chapter.title,
          chapterNumber: chapter.chapterNumber,
          content: null,
          locked: true,
          unlockDate: ud ? ud.toISOString().slice(0,10) : null,
          unlockCost: 10
        },
        prevChapter,
        nextChapter,
        allChapters,
        now: Date.now()
      });
    }

    // Unlocked path
    res.status(200).render("user/user-reader", {
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

router.post("/user/chapters/:chapterId/unlock", async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ ok: false, msg: "Login required" });
    }
    const userId = new ObjectId(req.session.userId);
    const { chapterId } = req.params;
    const cost = Math.max(1, parseInt((req.body?.cost ?? 10), 10));

    if (!ObjectId.isValid(chapterId)) {
      return res.status(400).json({ ok: false, msg: "Invalid chapter id" });
    }

    const dbi = db.get();
    const userCol = dbi.collection("user");
    const chaptersCol = dbi.collection("chapters");
    const purchasesCol = dbi.collection("purchases");

    // Ensure chapter exists
    const chapter = await chaptersCol.findOne({ _id: new ObjectId(chapterId) }, { projection: { _id: 1 } });
    if (!chapter) return res.status(404).json({ ok: false, msg: "Chapter not found" });

    // Already unlocked?
    const already = await purchasesCol.findOne({ userId, chapterId: chapter._id });
    if (already) {
      return res.status(200).json({ ok: true, msg: "Already unlocked" });
    }

    // Atomically deduct coins if enough
    const userDoc = await userCol.findOneAndUpdate(
      { _id: userId, coins: { $gte: cost } },
      { $inc: { coins: -cost } },
      { returnDocument: "after" }
    );
    

    // Record unlock. If this insert somehow fails, refund coins.
    try {
      await purchasesCol.insertOne({
        userId,
        chapterId: chapter._id,
        cost,
        at: new Date()
      });
    } catch (e) {
      await userCol.updateOne({ _id: userId }, { $inc: { coins: cost } });
      return res.status(500).json({ ok: false, msg: "Failed to record unlock" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("unlock error:", err);
    return res.status(500).json({ ok: false, msg: "Server error" });
  }
});

// USER SHOP
router.get("/user-shop", async (req, res) => {
  if (!req.session.userId) return res.redirect("/user/login");

  const dbuser = await db.get().collection("user").findOne({ _id: new ObjectId(req.session.userId) });

  if (dbuser && dbuser.plan && dbuser.plan.expires && new Date(dbuser.plan.expires) < new Date()) {
    await db.get().collection("user").updateOne(
      { _id: dbuser._id },
      { $set: { "plan.name": "Free", "plan.expires": null } }
    );
    dbuser.plan.name = "Free";
    dbuser.plan.expires = null;
  }

  const user = {
    Username: dbuser?.Username || "",
    type: "user",
    profileFrame: dbuser?.profileFrame || null
  };

  const profileLinks = { home: "/", profile: "/user/profile", logout: "/user/logout" };
  const coinCount = dbuser?.coins || 0;

  res.render("user/user-shop", {
    user,
    profileLinks,
    profileImageUrl: dbuser?.profileImage || null,
    profileFrame: user?.profileFrame || null,
    coinCount,
    membership: dbuser?.membership || null,
    plan: dbuser?.plan || { name: "Free", expires: null }
  });
});

// Coins purchase
router.post('/user/coins/purchase', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ success: false, message: "Login required" });
    const userId = new ObjectId(req.session.userId);
    const { amount } = req.body;
    const coins = parseInt(amount, 10);

    if (![20, 50, 100, 300, 500, 2000].includes(coins)) {
      return res.status(400).json({ success: false, message: "Invalid coin amount" });
    }

    await db.get().collection("user").updateOne(
      { _id: userId },
      { $inc: { coins } }
    );

    await db.get().collection('coin_transactions').insertOne({
      userType: 'user',
      userId,
      type: 'coin_purchase',
      amount: coins,
      status: 'success',
      paymentMethod: 'paypal',
      createdAt: new Date()
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Coin purchase error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Membership: Silver
router.post('/membership/silver/grant', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ ok: false, msg: 'Login required' });
    const userId = new ObjectId(req.session.userId);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db.get().collection("user").updateOne(
      { _id: userId },
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
      userType: 'user',
      userId,
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

// Membership: Gold
router.post('/membership/gold/grant', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ ok: false, msg: 'Login required' });
    const userId = new ObjectId(req.session.userId);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db.get().collection("user").updateOne(
      { _id: userId },
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
      userType: 'user',
      userId,
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

// Membership: Obsidian
router.post('/membership/obsidian/grant', async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ ok: false, msg: 'Login required' });
    const userId = new ObjectId(req.session.userId);

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await db.get().collection("user").updateOne(
      { _id: userId },
      {
        $set: {
          "plan.name": "Obsidian Edition",
          "plan.expires": expiresAt,
          "profileFrame": "obsidian"
        },
        $inc: { coins: 300 }
      }
    );

    await db.get().collection('coin_transactions').insertOne({
      userType: 'user',
      userId,
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

// Signup
router.get("/user/signup", (req, res) => {
  res.render("user/user-signup");
});

router.post("/user/signup", async (req, res) => {
  try {
    const usersCol = db.get().collection("user");
    // duplicates
    const existingUsername = await usersCol.findOne({ Username: req.body.Username });
    if (existingUsername) {
      return res.render("user/user-signup", { Exist: "Username already exists" });
    }
    const existingEmail = await usersCol.findOne({ Email: req.body.Email });
    if (existingEmail) {
      return res.render("user/user-signup", { Email: "Already registered with this email" });
    }

    const hashed = await bcrypt.hash(req.body.Password, 10);

    const userDoc = {
      Username: req.body.Username,
      Email: req.body.Email,
      Password: hashed,
      coins: 10,
      plan: { name: "Free", expires: null },
      createdAt: new Date()
    };

    await usersCol.insertOne(userDoc);

    return res.render("user/user-signup", {
      signupMessage: "Registration successful! You can now log in."
    });
  } catch (err) {
    console.error("An error occurred during signup:", err);
    res.status(500).send("An error occurred during signup: " + err.message);
  }
});

// Login
router.get("/user/login", (req, res) => {
  res.render("user/login-user", { Loginerr: req.session.Loginerr || null });
  req.session.Loginerr = null;
});

router.post("/user/login", async (req, res) => {
  const usersCol = db.get().collection("user");
  const user = await usersCol.findOne({ Username: req.body.Username });
  if (!user) {
    req.session.Loginerr = "Invalid username or password";
    return res.redirect("/user/login");
  }
  const isMatch = await bcrypt.compare(req.body.Password, user.Password);
  if (!isMatch) {
    req.session.Loginerr = "Invalid username or password";
    return res.redirect("/user/login");
  }

  // Store minimal identifiers
  req.session.User = user.Username;
  req.session.userId = user._id.toString();

  // Ensure session is saved before redirect in some store setups
  req.session.save(() => res.redirect("/"));
});

// Forgot password
router.get("/forgot-user", (req, res) => {
  res.render("user/forgot-user"); // form posts to /password-reset-user
});

// POST: request reset (no email)
router.post("/password-reset-user", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send("Email is required.");
  try {
    const usersCol = db.get().collection("user");
    const user = await usersCol.findOne({ Email: email });
    if (!user) return res.status(400).send("User not found.");

    // create random token and store hashed version
    const rawToken = crypto.randomBytes(16).toString("hex"); // 32 chars
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const tokenExpiration = new Date(Date.now() + 10 * 60 * 1000);

    await usersCol.updateOne(
      { _id: user._id },
      { $set: { resetTokenHash: tokenHash, tokenExpiration } }
    );

    // Show token directly to the user (no email)
    // Render a page that displays rawToken and a link to /user/reset-password?token=...
    return res.status(200).render("user/reset-token-show", {
      token: rawToken,
      resetUrl: `/user/reset-password?token=${rawToken}`
    });
  } catch (err) {
    console.error("Error preparing reset token:", err);
    res.status(500).send("An error occurred while preparing the reset token.");
  }
});

// GET: reset page (with token field prefilled if present)
router.get("/user/reset-password", (req, res) => {
  const { token } = req.query;
  res.render("user/Email-reset-user", { token: token || "" });
});

// POST: complete reset with token + new password
router.post("/update-password-user", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).send("Token and new password are required.");
  try {
    const usersCol = db.get().collection("user");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const user = await usersCol.findOne({ resetTokenHash: tokenHash });
    if (!user || new Date() > user.tokenExpiration) {
      return res.status(400).send("Token is invalid or expired.");
    }

    const hashedPassword = await bcrypt.hash(String(newPassword), 10);
    await usersCol.updateOne(
      { _id: user._id },
      { 
        $set: { Password: hashedPassword },
        $unset: { resetTokenHash: "", tokenExpiration: "" }
      }
    );
    res.status(200).send("Password reset successful.");
  } catch (err) {
    console.error("Error during password update:", err.message);
    res.status(500).send("An error occurred while updating the password.");
  }
});


// User profile
router.get("/user/profile", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/user/login");
  }

  const user = await db.get().collection("user").findOne({ _id: new ObjectId(req.session.userId) });
  if (!user) return res.status(404).send("User not found");

  let profileFrame = user.profileFrame || null;
  if (!profileFrame && user.plan && user.plan.name) {
    const planName = user.plan.name.toLowerCase();
    if (planName.includes("silver")) profileFrame = "silver";
    else if (planName.includes("gold")) profileFrame = "gold";
    else if (planName.includes("obsidian")) profileFrame = "obsidian";
  }

  res.render("user/user-profile", {
    user,
    profileImageUrl: user.profileImage || null,
    profileFrame,
    coinCount: user.coins || 0,
    membership: user.membership || null,
    plan: user.plan || { name: "Free", expires: null }
  });
});

// Edit profile
router.post('/user/profile/edit', async (req, res) => {
  try {
    const userIdRaw = req.session?.userId;
    if (!userIdRaw) return res.status(401).json({ error: "Not logged in" });

    const userId = new ObjectId(userIdRaw);
    const userCollection = db.get().collection('user');
    const user = await userCollection.findOne({ _id: userId });
    if (!user) return res.status(404).json({ error: "User not found" });

    const update = {};

    const incomingRaw = req.body?.Username ?? '';
    const incoming = String(incomingRaw).trim();
    const current = String(user.Username ?? '').trim();

    if (incoming && incoming !== current) {
      const now = Date.now();
      const lastChange = user.lastUsernameChange ? new Date(user.lastUsernameChange).getTime() : 0;
      const hasActiveMembership = !!(user.membership && user.membership.status === 'active');
      const renameWindowDays = hasActiveMembership ? 7 : 30;
      const renameWindowMs = renameWindowDays * 24 * 60 * 60 * 1000;

      if (lastChange && (now - lastChange < renameWindowMs)) {
        const remainingMs = renameWindowMs - (now - lastChange);
        const remainingDays = Math.ceil(remainingMs / (24*60*60*1000));
        return res.status(400).json({
          error: `Username can only be changed once every ${renameWindowDays} days. Try again in ~${remainingDays} day(s).`
        });
      }

      const exists = await userCollection.findOne({ Username: incoming, _id: { $ne: userId } });
      if (exists) return res.status(400).json({ error: "Username already exists." });

      update.Username = incoming;
      update.lastUsernameChange = now;
    }

    if (req.files && req.files.profileImage) {
      const image = req.files.profileImage;
      const uploadsDir = path.join(__dirname, '../public/images/profile-images/');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const filename = Date.now() + '-' + image.name.replace(/\s+/g, '_');
      const uploadPath = path.join(uploadsDir, filename);
      await image.mv(uploadPath);
      update.profileImage = `/images/profile-images/${filename}`;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No changes detected." });
    }

    await userCollection.updateOne({ _id: userId }, { $set: update });
    if (update.Username) req.session.User = update.Username;

    return res.json({ success: true });
  } catch (err) {
    console.error("Server error:", err.stack);
    return res.status(500).json({ error: "Server crashed during profile update." });
  }
});

// Remove Profile Photo
router.post("/user/profile/remove-photo", async (req, res) => {
  const userIdRaw = req.session.userId;
  if (!userIdRaw) return res.status(401).json({ success: false, message: "Not logged in" });
  const userId = new ObjectId(userIdRaw);
  await db.get().collection("user").updateOne(
    { _id: userId },
    { $set: { profileImage: null } }
  );
  res.json({ success: true });
});

// Claim daily reward: +1 coin once per UTC day
router.post("/user/rewards/daily", async (req, res) => {
  try {
    if (!req.session.userId) return res.status(401).json({ ok: false, error: "Login required" });

    const users = db.get().collection("user");
    const uid = new ObjectId(req.session.userId);

    const user = await users.findOne({ _id: uid }, { projection: { coins: 1, lastDailyClaim: 1 } });
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const last = user.lastDailyClaim ? new Date(user.lastDailyClaim) : null;
    const lastUTC = last ? new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate())) : null;

    if (lastUTC && lastUTC.getTime() === todayUTC.getTime()) {
      return res.status(200).json({ ok: true, claimed: false, coins: user.coins || 0, message: "Already claimed today" });
    }

    const result = await users.findOneAndUpdate(
      {
        _id: uid,
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
    const updated = result.value || await users.findOne({ _id: uid }, { projection: { coins: 1, lastDailyClaim: 1 } });

    return res.status(200).json({
      ok: true,
      claimed: true,
      coins: updated.coins || (user.coins || 0) + 1,
      message: "Daily reward claimed"
    });
  } catch (err) {
    console.error("Daily reward error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// // GET current reward-ad status
// router.get("/user/rewards/ads/status", async (req, res) => {
//   try {
//     if (!req.session.userId) return res.status(401).json({ ok:false, error:"Login required" });
//     const users = db.get().collection("user");
//     const uid = new ObjectId(req.session.userId);

//     const user = await users.findOne(
//       { _id: uid },
//       { projection: { coins:1, rewardAds:1 } }
//     );

//     const now = new Date();
//     const today = startOfUTCDay(now).toISOString();

//     // rewardAds schema suggestion:
//     // { day: "YYYY-MM-DDT00:00:00.000Z", completed: 0-2, lastTokens: [token strings], lastWatchedAt: Date }
//     const rad = user?.rewardAds || {};
//     const completed = (rad.day === today && Number.isFinite(rad.completed)) ? rad.completed : 0;

//     return res.json({
//       ok:true,
//       coins: user?.coins || 0,
//       completed,               // completed today
//       limit: 2,                // per-day limit
//       rewardPerAd: 5
//     });
//   } catch (e) {
//     console.error("ads/status", e);
//     res.status(500).json({ ok:false, error:"Server error" });
//   }
// });

// // POST start an ad session -> returns a short-lived token
// router.post("/user/rewards/ads/start", async (req, res) => {
//   try {
//     if (!req.session.userId) return res.status(401).json({ ok:false, error:"Login required" });
//     const users = db.get().collection("user");
//     const uid = new ObjectId(req.session.userId);

//     const user = await users.findOne({ _id: uid }, { projection: { rewardAds:1 } });
//     const now = new Date();
//     const dayISO = startOfUTCDay(now).toISOString();
//     const rad = user?.rewardAds || {};
//     const completed = (rad.day === dayISO && Number.isFinite(rad.completed)) ? rad.completed : 0;

//     if (completed >= 2) {
//       return res.status(200).json({ ok:true, allowed:false, message:"Daily ad limit reached" });
//     }

//     // Create a simple token with timestamp
//     const token = `${uid.toString()}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

//     // Save token & start time
//     const update = {
//       day: dayISO,
//       completed,
//       active: { token, startedAt: now },     // single active session
//       lastTokens: (rad.lastTokens || []).slice(-5),
//       lastWatchedAt: rad.lastWatchedAt || null
//     };
//     await users.updateOne(
//       { _id: uid },
//       { $set: { rewardAds: update } },
//       { upsert: true }
//     );

//     return res.json({ ok:true, allowed:true, token, minWatchSec: 20, rewardPerAd: 5 });
//   } catch (e) {
//     console.error("ads/start", e);
//     res.status(500).json({ ok:false, error:"Server error" });
//   }
// });

// // POST complete an ad session -> verifies watching duration and token, then pays
// router.post("/user/rewards/ads/complete", async (req, res) => {
//   try {
//     if (!req.session.userId) return res.status(401).json({ ok:false, error:"Login required" });
//     const { token } = req.body || {};
//     if (!token || typeof token !== "string") return res.status(400).json({ ok:false, error:"Invalid token" });

//     const users = db.get().collection("user");
//     const uid = new ObjectId(req.session.userId);

//     const user = await users.findOne({ _id: uid }, { projection: { coins:1, rewardAds:1 } });
//     if (!user) return res.status(404).json({ ok:false, error:"User not found" });

//     const now = new Date();
//     const dayISO = startOfUTCDay(now).toISOString();
//     const rad = user.rewardAds || {};
//     const completed = (rad.day === dayISO && Number.isFinite(rad.completed)) ? rad.completed : 0;

//     if (completed >= 2) {
//       return res.json({ ok:true, paid:false, coins: user.coins || 0, message:"Daily ad limit reached" });
//     }

//     // Validate token & minimal watch duration
//     const active = rad.active || null;
//     if (!active || active.token !== token) {
//       return res.status(400).json({ ok:false, error:"Session mismatch" });
//     }

//     const startedAt = new Date(active.startedAt);
//     const watchedSec = Math.floor((now - startedAt) / 1000);
//     const minWatchSec = 20; // must be >= 20s

//     if (watchedSec < minWatchSec) {
//       return res.status(200).json({ ok:true, paid:false, coins: user.coins || 0, message:"Watch time too short" });
//     }

//     // Pay 5 coins and increment completed
//     const reward = 5;
//     const nextCompleted = completed + 1;

//     await users.updateOne(
//       {
//         _id: uid,
//         "rewardAds.active.token": token,
//         // ensure still the same UTC day
//       },
//       {
//         $inc: { coins: reward },
//         $set: {
//           rewardAds: {
//             day: dayISO,
//             completed: nextCompleted,
//             active: null,
//             lastWatchedAt: now,
//             lastTokens: [ ...(rad.lastTokens || []), token ].slice(-10)
//           }
//         }
//       }
//     );

//     const fresh = await users.findOne({ _id: uid }, { projection: { coins:1, rewardAds:1 } });

//     return res.json({
//       ok:true,
//       paid:true,
//       coins: fresh.coins || (user.coins + reward),
//       completed: nextCompleted,
//       limit: 2,
//       rewardPerAd: reward,
//       message: "Reward granted"
//     });
//   } catch (e) {
//     console.error("ads/complete", e);
//     res.status(500).json({ ok:false, error:"Server error" });
//   }
// });

//user about
router.get("/user/about-user", async (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/user/login-user");
  }

  const user = await db.get().collection("user").findOne({ _id: new ObjectId(req.session.userId) });
  if (!user) return res.status(404).send("User not found");

  let profileFrame = user.profileFrame || null;
  res.render("user/about-user", {
    user,
    profileImageUrl: user.profileImage || null,
    profileFrame,
    coinCount: user.coins || 0
  });
});

// Logout (only current session)
router.get("/user/logout", (req, res) => {
  if (!req.session) {
    return res.redirect("/user/login");
  }
  const sid = req.sessionID;
  req.session.destroy(err => {
    // Always clear cookie for this app only
    res.clearCookie('readora.sid', { path: '/' });
    if (err) {
      console.error('Session destroy error for SID', sid, err);
      return res.redirect('/');
    }
    console.log('Session destroyed for SID', sid);
    return res.redirect("/user/login");
  });
});

module.exports = router;

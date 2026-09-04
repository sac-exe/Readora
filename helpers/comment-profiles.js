const { ObjectId } = require("mongodb");


// Older comments only contain a profile-image snapshot (or no image at all).
// Resolve the author from the account collections so every comment reflects the
// author's current profile image, even when the viewer is logged out.
async function hydrateCommentProfiles(database, comments) {
  const userIds = [];
  const staffIds = [];

  for (const comment of comments) {
    const userId = comment.userId || comment.user?._id;
    if (userId && ObjectId.isValid(userId)) userIds.push(new ObjectId(userId));
    if (comment.staffId && ObjectId.isValid(comment.staffId)) staffIds.push(new ObjectId(comment.staffId));
  }

  const [users, staff] = await Promise.all([
    userIds.length ? database.collection("user").find({ _id: { $in: userIds } }, { projection: { Username: 1, profileImage: 1, profileFrame: 1 } }).toArray() : [],
    staffIds.length ? database.collection("staff").find({ _id: { $in: staffIds } }, { projection: { Username: 1, profileImage: 1, profileFrame: 1 } }).toArray() : []
  ]);
  const people = new Map([...users, ...staff].map(person => [String(person._id), person]));

  return comments.map(comment => {
    const authorId = comment.staffId || comment.userId || comment.user?._id;
    const author = authorId ? people.get(String(authorId)) : null;
    return {
      ...comment,
      username: author?.Username || comment.username || "Reader",
      profileImageUrl: author?.profileImage || comment.profileImageUrl || null,
      profileFrame: author?.profileFrame || comment.profileFrame || null
    };
  });
}

module.exports = { hydrateCommentProfiles };

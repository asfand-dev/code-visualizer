const Post = require('../models/Post');
const { NotFoundError } = require('../utils/errors');

exports.listPosts = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const posts = await Post.find({ published: true })
    .sort({ createdAt: -1 })
    .skip((page - 1) * 20)
    .limit(20);
  res.json({ page, posts });
};

exports.getPost = async (req, res, next) => {
  const post = await Post.findById(req.params.postId).populate('author', 'name');
  if (!post) return next(new NotFoundError('Post not found'));
  res.json(post);
};

exports.createPost = async (req, res) => {
  // TODO: sanitize the markdown body before saving
  const post = await Post.create({ ...req.body, author: req.user.id });
  res.status(201).json(post);
};

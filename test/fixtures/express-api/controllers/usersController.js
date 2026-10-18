const User = require('../models/User');
const UserService = require('../services/UserService');
const { pick } = require('../utils/object');

const userService = new UserService(User);

async function list(req, res, next) {
  try {
    const users = await userService.findAll(req.query.role ? { role: req.query.role } : {});
    res.json(users);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const user = await userService.create(pick(req.body, ['name', 'email', 'password', 'role']));
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    res.json(await userService.findById(req.params.id));
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    res.json(await userService.update(req.params.id, pick(req.body, ['name', 'email'])));
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await userService.remove(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, getById, update, remove };

const express = require('express');
const auth = require('../middleware/auth');
const controller = require('../controllers/usersController');

const router = express.Router();

router.get('/', auth, controller.list);
router.post('/', auth, auth.requireRole('admin'), controller.create);

router
  .route('/:id')
  .get(auth, controller.getById)
  .patch(auth, controller.update)
  .delete(auth, auth.requireRole('admin'), controller.remove);

module.exports = router;

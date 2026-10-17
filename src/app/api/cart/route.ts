import { NextResponse } from 'next/server'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Helper function to find user by session
const getUserId = async () => {
  // In a real app, you would get this from cookies or session
  return 'default-user' // Placeholder
}

// Helper function to find cart by user
const getCart = async (userId) => {
  return await prisma.cart.findUnique({
    where: { userId },
    include: { items: true }
  })
}

// Helper function to create cart if it doesn't exist
const createCartIfNotExists = async (userId) => {
  return await prisma.cart.upsert({
    where: { userId },
    create: { userId },
    update: {}
  })
}

// Helper function to find cart item by productId
const findCartItem = async (cartId, productId) => {
  return await prisma.cartItem.findFirst({
    where: { cartId, productId }
  })
}

// GET: Retrieve cart items

export async function GET() {
  try {
    const userId = await getUserId()
    const cart = await getCart(userId)
    return NextResponse.json(cart?.items || [])
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch cart' }, { status: 500 })
  }
}

// POST: Add item to cart

export async function POST(request) {
  try {
    const { productId, quantity = 1 } = await request.json()
    const userId = await getUserId()
    const cart = await createCartIfNotExists(userId)
    const existingItem = await findCartItem(cart.id, productId)

    if (existingItem) {
      // Update existing item
      const updatedItem = await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantity: existingItem.quantity + quantity }
      })
      const updatedCart = await getCart(userId)
      return NextResponse.json(updatedCart?.items || [])
    } else {
      // Create new item
      const newItem = await prisma.cartItem.create({
        data: { cartId: cart.id, productId, quantity }
      })
      const updatedCart = await getCart(userId)
      return NextResponse.json(updatedCart?.items || [])
    }
  } catch (error) {
    return NextResponse.json({ error: 'Failed to add to cart' }, { status: 500 })
  }
}

// PUT: Update item quantity in cart

export async function PUT(request) {
  try {
    const { productId, quantity } = await request.json()
    const userId = await getUserId()
    const cart = await getCart(userId)

    if (!cart) {
      return NextResponse.json({ error: 'Cart not found' }, { status: 404 })
    }

    const item = await findCartItem(cart.id, productId)
    if (!item) {
      return NextResponse.json({ error: 'Item not found in cart' }, { status: 404 })
    }

    if (quantity <= 0) {
      // Remove item if quantity is 0 or less
      await prisma.cartItem.delete({
        where: { id: item.id }
      })
    } else {
      // Update quantity
      await prisma.cartItem.update({
        where: { id: item.id },
        data: { quantity }
      }
    )

    const updatedCart = await getCart(userId)
    return NextResponse.json(updatedCart?.items || [])
  } catch (error) {
    return NextResponse.json({ error: 'Failed to update cart' }, { status: 500 })
  }
}

// DELETE: Remove item from cart

export async function DELETE(request) {
  try {
    const { productId } = await request.json()
    const userId = await getUserId()
    const cart = await getCart(userId)

    if (!cart) {
      return NextResponse.json({ error: 'Cart not found' }, { status: 404 })
    }

    const item = await findCartItem(cart.id, productId)
    if (!item) {
      return NextResponse.json({ error: 'Item not found in cart' }, { status: 404 })
    }

    await prisma.cartItem.delete({
      where: { id: item.id }
    })

    const updatedCart = await getCart(userId)
    return NextResponse.json(updatedCart?.items || [])
  } catch (error) {
    return NextResponse.json({ error: 'Failed to remove item from cart' }, { status: 500 })
  }
}